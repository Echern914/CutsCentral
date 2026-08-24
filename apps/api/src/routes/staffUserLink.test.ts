import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests } from "../messaging/email.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import type { SendMessageInput } from "../messaging/provider.js";
import { __setPushSenderForTests, type PushPayload } from "../messaging/push.js";

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

/** Poll until the fire-and-forget notify legs land (they run post-response). */
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
  // The raw invite token exists ONLY in the email (we store its sha256).
  __setSendEmailForTests(async (input) => {
    const m = /token=([^\s&]+)/.exec(input.text ?? "");
    if (m) lastInviteToken = decodeURIComponent(m[1]!);
    return { id: "TEST", status: "sent" as const };
  });
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
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
  sent = [];
  pushes = [];
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
    await waitFor(() => pushes.length > 0 && sent.some((s) => s.to === BARBER_PHONE));

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
    await waitFor(() => sent.some((s) => s.to === BARBER_PHONE));
    sent = [];
    pushes = [];

    const res = await request(app).post(`/api/book/manage/${manageToken}/cancel`).send({});
    expect(res.status).toBe(200);
    await waitFor(() => pushes.length > 0);

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
    await waitFor(() => pushes.length > 0);

    // Unclaimed chair -> the owner, which is the behavior a solo shop relies on.
    const push = pushes.find((p) => p.payload.title === "New booking");
    expect(push!.endpoint).toBe("https://push.test/owner-device");
    expect(sent.map((s) => s.to)).toContain(OWNER_PHONE);
    expect(sent.map((s) => s.to)).not.toContain(BARBER_PHONE);
  });
});
