import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests } from "../messaging/email.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { SendMessageInput } from "../messaging/provider.js";
import { __setPushSenderForTests, type PushPayload } from "../messaging/push.js";
import {
  armBackgroundWorkTracking,
  backgroundWorkInFlight,
  disarmBackgroundWorkTracking,
  settleBackgroundWork,
} from "../backgroundWork.js";

/**
 * Staff.userId — the chair→login link that every barber alert routes on.
 *
 * The column existed since the native-booking migration and was READ by
 * recipientForAppointment() (services/barberNotify.ts), notifyBarberBookingEvent()
 * (services/appointmentNotify.ts), the manage-page cancel/reschedule paths in
 * booking.public.ts and both sweeps in engines/barberReminders.ts — every one of
 * them resolving `staff.userId ?? shop.ownerId`. Nothing ever WROTE it, so the
 * fallback fired every time and an employee barber was never notified about
 * their own chair.
 *
 * 🔑 WHY THIS FILE EXISTS ALONGSIDE barberReminders.test.ts. That suite already
 * asserts "routes each chair's appointment to ITS barber, not the owner" — and
 * passed throughout the bug, because its fixture sets `Staff.userId` by hand
 * (`prisma.staff.create({ data: { …, userId: otherUserId } })`). It proves the
 * engine reads the column correctly; it cannot prove the column is ever filled.
 * So EVERY test below reaches the link through the real product path — invite,
 * accept, re-link, remove — and never writes Staff.userId directly.
 */
const app = createApp();

const password = "correct horse battery staple";
const OWNER_PHONE = "+13025550100";
const BARBER_PHONE = "+13025550199";
const emails: string[] = [];
let lastInviteToken: string | null = null;

let sent: SendMessageInput[] = [];
let pushes: Array<{ endpoint: string; payload: PushPayload }> = [];
/** Milliseconds the fake SMS provider stalls before recording. 0 = immediate. */
let smsDelayMs = 0;

let ownerCookie: string;
let ownerEmail: string;
let ownerId: string;
let shopId: string;
let slug: string;
let serviceId: string;
/** The chair the invited barber will hold. */
let chairId: string;
/** A second chair, so re-linking has somewhere to move to. */
let spareChairId: string;
/** The service given to that chair, reused by the contamination pair below. */
let spareServiceId: string;

const ORIGINAL_DRY_RUN = process.env.DRY_RUN;

async function signup(email: string, name = "Person"): Promise<string> {
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name, smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

/** Invite + accept, the whole real path. Returns the new member's id. */
async function seatBarber(
  email: string,
  staffId: string | undefined,
): Promise<{ memberId: string; userId: string; cookie: string }> {
  const invited = await request(app)
    .post("/api/team/invites")
    .set("Cookie", ownerCookie)
    .send({ email, role: "BARBER", ...(staffId ? { staffId } : {}) });
  expect(invited.status).toBe(201);
  expect(lastInviteToken).toBeTruthy();
  const token = lastInviteToken!;

  const cookie = await signup(email, "Barber");
  const join = await request(app)
    .post("/api/team/join")
    .set("Cookie", cookie)
    .send({ token });
  expect(join.status).toBe(201);

  const member = await prisma.shopMember.findFirst({
    where: { shopId, user: { email } },
    select: { id: true, userId: true },
  });
  expect(member).toBeTruthy();
  return { memberId: member!.id, userId: member!.userId, cookie };
}

async function chairUserId(staffId: string): Promise<string | null> {
  const row = await prisma.staff.findUnique({
    where: { id: staffId },
    select: { userId: true },
  });
  return row?.userId ?? null;
}

async function newChair(name: string): Promise<string> {
  const res = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", ownerCookie)
    .send({ name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/**
 * Wait for THIS test's notifications to finish - both legs, not one.
 *
 * 🔴 WHY POLLING FOR AN EFFECT IS NOT ENOUGH, and what went wrong before.
 * A booking route dispatches its notification with `void notify(...)`, so it
 * responds before the barber's push and SMS have been sent. This file used to
 * poll for whichever effect a test cared about:
 *
 *     await waitFor(() => pushes.length > 0);
 *     expect(sent.map((s) => s.to)).not.toContain(BARBER_PHONE);
 *
 * Push and SMS are two independent legs of one dispatch. Waiting for the push
 * says nothing about the SMS, so the test could finish with an SMS still in
 * flight; `beforeEach` then cleared `sent`, the straggler landed in the NEXT
 * test's array, and that test failed on a message it never caused. It passed
 * everywhere except a loaded CI runner, which is the worst possible place for
 * it to be the only thing that fails.
 *
 * `settleBackgroundWork` counts the dispatches themselves, so "nothing of mine
 * is still running" is a fact rather than a guess about timing. Every test
 * below that triggers a notification ends with this, and `afterEach` repeats it
 * as a floor - so a test added later that forgets still cannot leak into its
 * neighbour.
 */
async function settleNotifications(): Promise<void> {
  await settleBackgroundWork();
}

/** Poll until a condition holds. Only for effects, never for quiescence. */
async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(pred()).toBe(true);
}

function futureAtHour(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

beforeAll(async () => {
  process.env.DRY_RUN = "false";
  __resetEnvCacheForTests();
  // Armed before anything can dispatch, so no notification escapes counting.
  armBackgroundWorkTracking();
  // The raw invite token exists ONLY in the email (we store its sha256).
  __setSendEmailForTests(async (input) => {
    const m = /token=([^\s&]+)/.exec(input.text ?? "");
    if (m) lastInviteToken = decodeURIComponent(m[1]!);
    return { id: "TEST", status: "sent" as const };
  });
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      // `smsDelayMs` lets a test make the SMS leg arrive LATE on purpose - the
      // shape a loaded CI runner produces by accident. See the regression test
      // at the end of this file.
      if (smsDelayMs > 0) await new Promise((r) => setTimeout(r, smsDelayMs));
      sent.push(input);
      return { sid: `SM-fake-${sent.length}`, status: "queued" };
    },
  });
  __setPushSenderForTests({
    send: async (sub, payload) => {
      pushes.push({
        endpoint: (sub as { endpoint: string }).endpoint,
        payload: JSON.parse(payload) as PushPayload,
      });
    },
  });

  ownerEmail = `chairlink-o-${randomToken(6).toLowerCase()}@test.chairback`;
  ownerCookie = await signup(ownerEmail, "Owner");
  const created = await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name: "Chair Link Cuts", smsAttested: true });
  expect(created.status).toBe(201);

  // Native booking, UTC, and a shop-wide alert number so the "fell back to the
  // owner" failure would be VISIBLE rather than silent.
  const patched = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", ownerCookie)
    .send({
      bookingMode: "native",
      timezone: "UTC",
      bookingLeadHours: 1,
      notifyPhone: OWNER_PHONE,
    });
  expect(patched.status).toBe(200);

  const me = await request(app).get("/api/shops/me").set("Cookie", ownerCookie);
  shopId = me.body.id as string;
  slug = me.body.slug as string;
  ownerId = (await prisma.user.findUnique({
    where: { email: ownerEmail },
    select: { id: true },
  }))!.id;

  chairId = await newChair("Dre");
  spareChairId = await newChair("Marcus");

  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", ownerCookie)
    .send({ name: "Fade", durationMin: 30, price: 40, staffIds: [chairId] });
  expect(service.status).toBe(201);
  serviceId = service.body.id as string;

  await request(app)
    .put(`/api/booking/staff/${chairId}/availability`)
    .set("Cookie", ownerCookie)
    .send({
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startMin: 9 * 60,
        endMin: 17 * 60,
      })),
    });

  // The OWNER has a device too. If routing regresses, the alert lands here and
  // the assertions below fail loudly instead of just finding nothing.
  await prisma.pushSubscription.create({
    data: {
      shopId,
      userId: ownerId,
      kind: "web",
      endpoint: "https://push.test/owner-device",
      p256dh: "fake-p256dh",
      auth: "fake-auth",
    },
  });
});

afterAll(async () => {
  if (ORIGINAL_DRY_RUN === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = ORIGINAL_DRY_RUN;
  __resetEnvCacheForTests();
  // Drain before unhooking the fakes: an in-flight notification that reached a
  // torn-down sender would throw into nobody's test.
  await settleBackgroundWork();
  disarmBackgroundWorkTracking();
  __setSendEmailForTests(undefined);
  __setMessageProviderForTests(undefined);
  __setPushSenderForTests(undefined);
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

beforeEach(() => {
  lastInviteToken = null;
  smsDelayMs = 0;
  sent = [];
  pushes = [];
});

/**
 * 🔴 THE FLOOR, and the reason this is in `afterEach` rather than trusted to
 * each test. Vitest runs afterEach(N) fully before beforeEach(N+1), so draining
 * here means the capture arrays are cleared with NOTHING in flight - which is
 * what makes "a previous test cannot contaminate the next one" structural
 * rather than a property of how carefully each test was written.
 *
 * Individual tests still settle before their own assertions, because they need
 * their notifications to have HAPPENED. This guarantees the different thing:
 * that none of them outlive the test that caused them.
 */
afterEach(async () => {
  await settleBackgroundWork();
});

describe("the chair link follows the seat", () => {
  it("is set when an invite naming a chair is accepted", async () => {
    // Its own chair: ShopMember.staffId is unique, so a chair can be claimed
    // exactly once and chairId belongs to the alerts block below.
    const chair = await newChair("Freshly Seated");
    expect(await chairUserId(chair)).toBeNull();
    const { userId } = await seatBarber(
      `accept-${randomToken(6).toLowerCase()}@test.chairback`,
      chair,
    );
    expect(await chairUserId(chair)).toBe(userId);
  });

  it("moves to the new chair and releases the old one", async () => {
    const a = await newChair("Rotating A");
    const b = await newChair("Rotating B");
    const { memberId, userId } = await seatBarber(
      `move-${randomToken(6).toLowerCase()}@test.chairback`,
      a,
    );
    expect(await chairUserId(a)).toBe(userId);

    const res = await request(app)
      .patch(`/api/team/members/${memberId}`)
      .set("Cookie", ownerCookie)
      .send({ staffId: b });
    expect(res.status).toBe(200);

    expect(await chairUserId(a)).toBeNull();
    expect(await chairUserId(b)).toBe(userId);
  });

  it("clears when the chair link is removed", async () => {
    const c = await newChair("Unlinkable");
    const { memberId, userId } = await seatBarber(
      `unlink-${randomToken(6).toLowerCase()}@test.chairback`,
      c,
    );
    expect(await chairUserId(c)).toBe(userId);

    const res = await request(app)
      .patch(`/api/team/members/${memberId}`)
      .set("Cookie", ownerCookie)
      .send({ staffId: null });
    expect(res.status).toBe(200);
    expect(await chairUserId(c)).toBeNull();
  });

  it("is untouched by a role-only edit", async () => {
    const c = await newChair("Promotable");
    const { memberId, userId } = await seatBarber(
      `role-${randomToken(6).toLowerCase()}@test.chairback`,
      c,
    );
    const res = await request(app)
      .patch(`/api/team/members/${memberId}`)
      .set("Cookie", ownerCookie)
      .send({ role: "MANAGER" });
    expect(res.status).toBe(200);
    expect(await chairUserId(c)).toBe(userId);
  });

  it("is released when the seat is removed, leaving the chair itself intact", async () => {
    const c = await newChair("Departing");
    const { memberId } = await seatBarber(
      `remove-${randomToken(6).toLowerCase()}@test.chairback`,
      c,
    );
    const res = await request(app)
      .delete(`/api/team/members/${memberId}`)
      .set("Cookie", ownerCookie);
    expect(res.status).toBe(200);

    expect(await chairUserId(c)).toBeNull();
    // The Staff row survives - revoking access must never rewrite the calendar.
    const chair = await prisma.staff.findUnique({
      where: { id: c },
      select: { name: true, active: true },
    });
    expect(chair).toMatchObject({ name: "Departing", active: true });
  });

  it("a seat with no chair leaves every chair alone", async () => {
    const before = await chairUserId(spareChairId);
    await seatBarber(`nochair-${randomToken(6).toLowerCase()}@test.chairback`, undefined);
    expect(await chairUserId(spareChairId)).toBe(before);
  });

  it("releasing one seat cannot wipe another person's link", async () => {
    const mine = await newChair("Mine");
    const theirs = await newChair("Theirs");
    const a = await seatBarber(`race-a-${randomToken(6).toLowerCase()}@test.chairback`, mine);
    const b = await seatBarber(`race-b-${randomToken(6).toLowerCase()}@test.chairback`, theirs);

    // Hand A's chair to B behind the seat table, the shape a race would leave.
    await prisma.staff.update({ where: { id: mine }, data: { userId: b.userId } });
    const res = await request(app)
      .delete(`/api/team/members/${a.memberId}`)
      .set("Cookie", ownerCookie);
    expect(res.status).toBe(200);

    // The clear is scoped by userId, so B's link survives A's departure.
    expect(await chairUserId(mine)).toBe(b.userId);
    expect(await chairUserId(theirs)).toBe(b.userId);
  });
});

describe("alerts reach the barber whose chair it is", () => {
  let barberUserId: string;

  beforeAll(async () => {
    const seated = await seatBarber(
      `alerts-${randomToken(6).toLowerCase()}@test.chairback`,
      chairId,
    );
    barberUserId = seated.userId;
    // Their own device and their own alert number - the two things that made
    // "the owner got it instead" indistinguishable from "nobody was reachable".
    await prisma.pushSubscription.create({
      data: {
        shopId,
        userId: barberUserId,
        kind: "web",
        endpoint: "https://push.test/barber-device",
        p256dh: "fake-p256dh",
        auth: "fake-auth",
      },
    });
    await prisma.barberNotifyPref.create({
      data: { shopId, userId: barberUserId, notifyPhone: BARBER_PHONE },
    });
  });

  async function book(startsAt: Date, firstName: string) {
    const res = await request(app).post(`/api/book/${slug}`).send({
      staffId: chairId,
      serviceId,
      startsAt: startsAt.toISOString(),
      firstName,
      lastName: "Okafor",
      phone: "(302) 555-0411",
      email: "cust0411@example.com",
      smsConsent: true,
    });
    expect(res.status).toBe(201);
    return res.body as { manageToken: string };
  }

  it("a new booking pushes the barber's device and texts the barber's number", async () => {
    await book(futureAtHour(2, 10), "Malik");
    // Both legs, by construction. Polling for "a push AND a barber SMS" would
    // also pass here, but only because this test happens to assert on both -
    // and it would still leave the CUSTOMER confirmation in flight.
    await settleNotifications();

    const push = pushes.find((p) => p.payload.title === "New booking");
    expect(push).toBeTruthy();
    expect(push!.endpoint).toBe("https://push.test/barber-device");
    expect(push!.payload.body).toContain("Malik Okafor just booked Fade with Dre");

    // The owner's device and the shop-wide number are NOT used: the chair has
    // its own person now, and this is the assertion the bug would fail.
    expect(pushes.map((p) => p.endpoint)).not.toContain("https://push.test/owner-device");
    expect(sent.map((s) => s.to)).not.toContain(OWNER_PHONE);
    expect(sent.filter((s) => s.to === BARBER_PHONE)).toHaveLength(1);
  });

  it("a customer cancellation reaches the same barber", async () => {
    const { manageToken } = await book(futureAtHour(3, 11), "Priya");
    // 🔴 THE SAME TRAP, INSIDE ONE TEST. This waited for the booking's SMS and
    // then cleared both arrays - so the booking's PUSH, still in flight, landed
    // in the arrays meant for the cancellation and the assertions below read a
    // "New booking" push as if it were the cancellation's.
    await settleNotifications();
    sent = [];
    pushes = [];

    const res = await request(app).post(`/api/book/manage/${manageToken}/cancel`).send({});
    expect(res.status).toBe(200);
    await settleNotifications();

    const push = pushes.find((p) => p.payload.body.includes("canceled"));
    expect(push).toBeTruthy();
    expect(push!.endpoint).toBe("https://push.test/barber-device");
    expect(pushes.map((p) => p.endpoint)).not.toContain("https://push.test/owner-device");
  });

  it("falls back to the owner for a chair nobody holds", async () => {
    // spareChairId has no seat. Give it a service + hours, then book it.
    const svc = await request(app)
      .post("/api/booking/services")
      .set("Cookie", ownerCookie)
      .send({ name: "Lineup", durationMin: 20, price: 20, staffIds: [spareChairId] });
    expect(svc.status).toBe(201);
    spareServiceId = svc.body.id as string;
    await request(app)
      .put(`/api/booking/staff/${spareChairId}/availability`)
      .set("Cookie", ownerCookie)
      .send({
        rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          startMin: 9 * 60,
          endMin: 17 * 60,
        })),
      });

    const res = await request(app).post(`/api/book/${slug}`).send({
      staffId: spareChairId,
      serviceId: svc.body.id,
      startsAt: futureAtHour(4, 12).toISOString(),
      firstName: "Owner",
      lastName: "Route",
      phone: "(302) 555-0422",
      email: "cust0422@example.com",
      smsConsent: true,
    });
    expect(res.status).toBe(201);
    // 🔴 THE ASSERTION THAT WENT RED IN CI. It waited for the PUSH and then
    // asserted about SMS, so the barber SMS it is asserting the ABSENCE of
    // could still be the previous test's, arriving after `beforeEach` cleared
    // the array. Settling makes "no barber SMS" a statement about this test.
    await settleNotifications();

    // Unclaimed chair -> the owner, which is the behavior a solo shop relies on.
    const push = pushes.find((p) => p.payload.title === "New booking");
    expect(push!.endpoint).toBe("https://push.test/owner-device");
    expect(sent.map((s) => s.to)).toContain(OWNER_PHONE);
    expect(sent.map((s) => s.to)).not.toContain(BARBER_PHONE);
  });

  /**
   * 🔴 THE REGRESSION TEST FOR THE RACE ITSELF, not for what it broke.
   *
   * The pair below reproduces the CI failure deliberately: the first test makes
   * the barber's SMS arrive LATE - far later than its own push, which is what a
   * loaded runner does by accident - and the second is the victim, asserting
   * that no barber SMS reached it.
   *
   * Without the drain the delayed SMS lands in the second test's freshly
   * cleared array and `not.toContain(BARBER_PHONE)` fails, which is exactly the
   * observed `[ '+13025550199', '+13025550100' ]`. With it, the first test
   * cannot finish while its own SMS is outstanding, so there is nothing left to
   * leak. Deleting the `settleNotifications()` calls or the `afterEach` drain
   * turns the second test red.
   */
  it("a delayed SMS is still THIS test's, however late the provider is", async () => {
    smsDelayMs = 250;
    await book(futureAtHour(6, 10), "Late");
    await settleNotifications();

    // It landed here, where it belongs - not in whatever runs next.
    expect(sent.some((s) => s.to === BARBER_PHONE)).toBe(true);
    // And the drain is a fact about the dispatches, not a sleep that was long
    // enough: nothing is outstanding at the moment this test ends.
    expect(backgroundWorkInFlight()).toBe(0);
  });

  it("🔴 and the NEXT test is clean, which is the whole point", async () => {
    // Runs immediately after the delayed-SMS test above. Under the old code
    // this is where that stray '+13025550199' turned up.
    expect(sent).toHaveLength(0);
    expect(pushes).toHaveLength(0);

    // Book on the unclaimed chair again: the owner is texted, the barber is not
    // - and "not" now means something, because nothing from the previous test
    // can still be arriving.
    const res = await request(app).post(`/api/book/${slug}`).send({
      staffId: spareChairId,
      serviceId: spareServiceId,
      startsAt: futureAtHour(7, 12).toISOString(),
      firstName: "Clean",
      lastName: "Slate",
      phone: "(302) 555-0423",
      email: "cust0423@example.com",
      smsConsent: true,
    });
    expect(res.status).toBe(201);
    await settleNotifications();

    expect(sent.map((s) => s.to)).toContain(OWNER_PHONE);
    expect(sent.map((s) => s.to)).not.toContain(BARBER_PHONE);
  });
});
