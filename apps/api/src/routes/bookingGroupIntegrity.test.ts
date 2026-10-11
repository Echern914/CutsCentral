import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { createApp } from "../app.js";
import { shopDayAhead } from "../testing/shopDay.js";
import { __setPushSenderForTests, type PushPayload } from "../messaging/push.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import {
  armBackgroundWorkTracking,
  disarmBackgroundWorkTracking,
  settleBackgroundWork,
} from "../backgroundWork.js";
import { groupConfirmationKey, settleAmbiguousGroups } from "../engines/appointmentGroupSettle.js";
import { raceBehindAdvisoryLock, winners } from "../testing/raceBarrier.js";

/**
 * A party ("me and my brother, back to back") has to obey every rule a single
 * booking obeys - approval, the past-time rule, the double-booking guard on the
 * chair each person actually sits in, a fresh reminder after a move - and the
 * booker's own record must not be rewritten from an attendee's appointment.
 */
const app = createApp();
const TZ = "America/New_York";
const DAY = shopDayAhead(7, TZ, { avoidDstChange: true });
const at = (minutesFromMidnight: number) =>
  zonedWallTimeToUtc(DAY.y, DAY.m0, DAY.d, minutesFromMidnight, TZ);
const TWO_PM = at(14 * 60);
const MIN = 60_000;

const ownerEmail = `grpint-${randomToken(6)}@test.local`.toLowerCase();
let cookie: string;
let slug: string;
let shopId: string;
let chairA: string;
let chairB: string;
let cutId: string;
let kidsId: string;
let pushes: PushPayload[] = [];
const ORIGINAL_DRY_RUN = process.env.DRY_RUN;

const booker = {
  firstName: "Eric",
  lastName: "Chern",
  phone: "+12015550134",
  email: "eric@test.chairback",
};
const party = () => [
  { firstName: "Eric", serviceId: cutId }, // 30 min
  { firstName: "Brother", serviceId: kidsId }, // 20 min
];

const createParty = (startsAt: Date = TWO_PM) =>
  request(app)
    .post(`/api/book/${slug}/group`)
    .send({ staffId: chairA, startsAt: startsAt.toISOString(), attendees: party(), ...booker });

const members = (groupId: string) =>
  prisma.appointment.findMany({
    where: { groupId },
    orderBy: { groupPosition: "asc" },
  });

const dashboard = (path: string, body: object = {}) =>
  request(app).post(`/api/booking${path}`).set("Cookie", cookie).send(body);

async function setShop(data: { requireBookingApproval?: boolean; bookingBufferMin?: number }) {
  await prisma.shop.update({ where: { id: shopId }, data });
}

/** Somebody else's booking, straight onto a chair. */
async function otherBooking(staffId: string, startsAt: Date, minutes: number) {
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId: cutId,
      firstName: "Stranger",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + minutes * MIN),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
}

beforeAll(async () => {
  process.env.DRY_RUN = "false";
  __resetEnvCacheForTests();
  __setMessageProviderForTests({
    channel: "SMS",
    send: async () => ({ sid: `SM-${randomToken(4)}`, status: "queued" }),
  });
  __setPushSenderForTests({
    send: async (_sub, payload) => {
      pushes.push(JSON.parse(payload) as PushPayload);
    },
  });
  armBackgroundWorkTracking();

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email: ownerEmail, password: "supersecret123", name: "Grp", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Party Integrity Cuts", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: TZ, bookingLeadHours: 2 });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;
  shopId = me.body.id;

  const a = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  const b = await prisma.staff.create({ data: { shopId, name: "Bea" }, select: { id: true } });
  chairA = a.id;
  chairB = b.id;
  for (const staffId of [chairA, chairB]) {
    await prisma.availabilityRule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        shopId,
        staffId,
        weekday,
        startMin: 10 * 60,
        endMin: 20 * 60,
      })),
    });
  }
  const cut = await prisma.service.create({
    data: { shopId, name: "Haircut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  const kids = await prisma.service.create({
    data: { shopId, name: "Kids cut", durationMin: 20, price: 25 },
    select: { id: true },
  });
  cutId = cut.id;
  kidsId = kids.id;
  for (const serviceId of [cutId, kidsId]) {
    for (const staffId of [chairA, chairB]) {
      await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
    }
  }
  // The owner's phone - where the shop's own alerts land.
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } });
  await prisma.pushSubscription.create({
    data: {
      shopId,
      userId: owner.id,
      kind: "web",
      endpoint: `https://push.test/owner-${randomToken(6)}`,
      p256dh: "k",
      auth: "a",
    },
  });
});

beforeEach(async () => {
  pushes = [];
  await setShop({ requireBookingApproval: false, bookingBufferMin: 0 });
});

afterEach(async () => {
  await settleBackgroundWork();
  await prisma.emailIntent.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.appointmentGroup.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  disarmBackgroundWorkTracking();
  if (ORIGINAL_DRY_RUN === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = ORIGINAL_DRY_RUN;
  __resetEnvCacheForTests();
  __setMessageProviderForTests(undefined);
  __setPushSenderForTests(undefined);
  const user = await prisma.user.findUnique({ where: { email: ownerEmail } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("🔴 1. request-before-booking: a party arrives as ONE request", () => {
  beforeEach(() => setShop({ requireBookingApproval: true }));

  it("every member is PENDING, nothing confirms, the page is told it is a request", async () => {
    const res = await createParty();
    expect(res.status).toBe(201);
    expect(res.body.pending).toBe(true);

    const rows = await members(res.body.groupId);
    expect(rows.map((r) => [r.status, r.holdExpiresAt])).toEqual([
      ["PENDING", null],
      ["PENDING", null],
    ]);
    // No confirmation promised - that is what approval sends.
    const group = await prisma.appointmentGroup.findUniqueOrThrow({
      where: { id: res.body.groupId },
    });
    expect(group.confirmationEnqueuedAt).toBeNull();
    expect(
      await prisma.emailIntent.count({
        where: { idempotencyKey: groupConfirmationKey(res.body.groupId) },
      }),
    ).toBe(0);

    // The shop is alerted ONCE that a party is waiting, not once per chair.
    await settleBackgroundWork();
    const alerts = pushes.filter((p) => p.title === "New booking request");
    expect(alerts).toHaveLength(1);

    // The party's page reads "waiting", never "cancelled", and the client can
    // neither cancel nor move a request - exactly like a single request.
    const view = await request(app).get(`/api/book/group/${res.body.manageToken}`);
    expect(view.body).toMatchObject({ status: "ACTIVE", requested: true });
    expect(view.body.startsAt).toBe(TWO_PM.toISOString());
    const cancel = await request(app).post(`/api/book/group/${res.body.manageToken}/cancel`);
    expect(cancel.status).toBe(409);
    expect(cancel.body.error).toBe("not_cancelable");
    const move = await request(app)
      .post(`/api/book/group/${res.body.manageToken}/reschedule`)
      .send({ startsAt: at(16 * 60).toISOString() });
    expect(move.status).toBe(409);
    expect(move.body.error).toBe("not_reschedulable");
    expect((await members(res.body.groupId)).every((r) => r.status === "PENDING")).toBe(true);
  });

  it("approving ANY member approves the whole party and claims its ONE confirmation", async () => {
    // A turnover buffer: approved one at a time, member 2 would sit inside
    // member 1's buffer and be refused. The party is checked as one run.
    await setShop({ bookingBufferMin: 10 });
    const res = await createParty();
    const [, second] = await members(res.body.groupId);

    const approve = await dashboard(`/appointments/${second!.id}/approve`);
    expect(approve.status).toBe(200);
    expect(approve.body).toMatchObject({ ok: true, party: 2 });

    expect((await members(res.body.groupId)).map((r) => r.status)).toEqual(["BOOKED", "BOOKED"]);
    const group = await prisma.appointmentGroup.findUniqueOrThrow({
      where: { id: res.body.groupId },
    });
    expect(group.confirmationEnqueuedAt).not.toBeNull();
    expect(
      await prisma.emailIntent.count({
        where: { idempotencyKey: groupConfirmationKey(res.body.groupId) },
      }),
    ).toBe(1);

    // Already answered: idempotent, like the single approve.
    const again = await dashboard(`/appointments/${second!.id}/approve`);
    expect(again.status).toBe(404);
  });

  it("declining ANY member declines the whole party and ends it", async () => {
    const res = await createParty();
    const [first] = await members(res.body.groupId);

    const decline = await dashboard(`/appointments/${first!.id}/decline`);
    expect(decline.status).toBe(200);
    expect(decline.body).toMatchObject({ ok: true, party: 2 });

    expect((await members(res.body.groupId)).map((r) => r.status)).toEqual([
      "CANCELED",
      "CANCELED",
    ]);
    const group = await prisma.appointmentGroup.findUniqueOrThrow({
      where: { id: res.body.groupId },
    });
    expect(group.status).toBe("CANCELED");
    expect(group.confirmationEnqueuedAt).toBeNull();
  });

  it("🔴 a request whose calendar mirror settles is NOT confirmed by the sweep - approval confirms it", async () => {
    const res = await createParty();
    // As the 202 path leaves it: the party's Acuity answer still outstanding.
    await prisma.appointmentGroup.update({
      where: { id: res.body.groupId },
      data: { mirrorPendingSince: new Date() },
    });

    await settleAmbiguousGroups(shopId);
    const settled = await prisma.appointmentGroup.findUniqueOrThrow({
      where: { id: res.body.groupId },
    });
    expect(settled.mirrorPendingSince).toBeNull();
    // Nobody has accepted this party: its one confirmation is still unspent...
    expect(settled.confirmationEnqueuedAt).toBeNull();

    // ...so the shop's approval is what sends it.
    const [first] = await members(res.body.groupId);
    expect((await dashboard(`/appointments/${first!.id}/approve`)).status).toBe(200);
    const approved = await prisma.appointmentGroup.findUniqueOrThrow({
      where: { id: res.body.groupId },
    });
    expect(approved.confirmationEnqueuedAt).not.toBeNull();
  });

  it("approved while the calendar is still unresolved: the confirmation waits for the sweep", async () => {
    const res = await createParty();
    await prisma.appointmentGroup.update({
      where: { id: res.body.groupId },
      data: { mirrorPendingSince: new Date() },
    });
    const [first] = await members(res.body.groupId);
    expect((await dashboard(`/appointments/${first!.id}/approve`)).status).toBe(200);
    const held = await prisma.appointmentGroup.findUniqueOrThrow({
      where: { id: res.body.groupId },
    });
    expect(held.confirmationEnqueuedAt).toBeNull();

    // The calendar answers (no blocks to wait on here): now it is confirmed.
    await settleAmbiguousGroups(shopId);
    const confirmed = await prisma.appointmentGroup.findUniqueOrThrow({
      where: { id: res.body.groupId },
    });
    expect(confirmed.confirmationEnqueuedAt).not.toBeNull();
  });

  it("🔴 a member's own chair taken since: the WHOLE party is refused, nobody approved", async () => {
    const res = await createParty();
    const [, second] = await members(res.body.groupId);
    // The shop moved the brother to the other chair, where somebody else has
    // since booked across his time.
    await prisma.appointment.update({ where: { id: second!.id }, data: { staffId: chairB } });
    await otherBooking(chairB, new Date(second!.startsAt.getTime() + 5 * MIN), 30);

    const approve = await dashboard(`/appointments/${second!.id}/approve`);
    expect(approve.status).toBe(409);
    expect(approve.body.error).toBe("slot_taken");
    expect((await members(res.body.groupId)).map((r) => r.status)).toEqual(["PENDING", "PENDING"]);
  });
});

describe("🔴 2. moving a party checks every member on the chair it actually sits in", () => {
  it("a member moved to another provider cannot be landed on that provider's booking", async () => {
    const res = await createParty();
    expect(res.status).toBe(201);
    const [first, second] = await members(res.body.groupId);
    await prisma.appointment.update({ where: { id: second!.id }, data: { staffId: chairB } });
    // Chair B is booked 4:35-5:05. Moving the party to 4:00 puts the brother
    // on chair B at 4:30-4:50 - straight across it. Chair A is free.
    await otherBooking(chairB, at(16 * 60 + 35), 30);

    const move = await request(app)
      .post(`/api/book/group/${res.body.manageToken}/reschedule`)
      .send({ startsAt: at(16 * 60).toISOString() });
    expect(move.status).toBe(409);
    expect(move.body.error).toBe("slot_taken");

    // NOBODY moved.
    const after = await members(res.body.groupId);
    expect(after.map((r) => [r.staffId, r.startsAt.toISOString()])).toEqual([
      [chairA, first!.startsAt.toISOString()],
      [chairB, second!.startsAt.toISOString()],
    ]);

    // Somewhere chair B is free, the move goes ahead - each member staying on
    // the chair the shop put them on.
    const ok = await request(app)
      .post(`/api/book/group/${res.body.manageToken}/reschedule`)
      .send({ startsAt: at(18 * 60).toISOString() });
    expect(ok.status).toBe(200);
    const moved = await members(res.body.groupId);
    expect(moved.map((r) => [r.staffId, r.startsAt.toISOString()])).toEqual([
      [chairA, at(18 * 60).toISOString()],
      [chairB, at(18 * 60 + 30).toISOString()],
    ]);
  });

  it("🔴 the move queues on the OTHER chair's lock: racing a booking there, exactly one wins", async () => {
    const res = await createParty();
    const [, second] = await members(res.body.groupId);
    await prisma.appointment.update({ where: { id: second!.id }, data: { staffId: chairB } });

    // Held on chair B - the chair the party's own chair (A) knows nothing
    // about. A move that locked only chair A would sail through while it is
    // held (settledEarly 1) and land on top of the other booking.
    const { results, settledEarly } = await raceBehindAdvisoryLock(`appt:${chairB}`, [
      () =>
        request(app)
          .post(`/api/book/group/${res.body.manageToken}/reschedule`)
          .send({ startsAt: at(16 * 60).toISOString() })
          .then((r) => r.status),
      // 4:40-5:00 on chair B: across the brother's 4:30-4:50, but NOT the same
      // start minute - so only the overlap check, never the (staffId, startsAt)
      // unique index, can be what keeps the two apart.
      () =>
        request(app)
          .post(`/api/book/${slug}`)
          .send({
            staffId: chairB,
            serviceId: kidsId,
            startsAt: at(16 * 60 + 40).toISOString(),
            firstName: "Walk",
            lastName: "Up",
            phone: "+12015550177",
            email: "walkup@test.chairback",
          })
          .then((r) => r.status),
    ]);
    expect(settledEarly).toBe(0);
    const [moveStatus, bookStatus] = winners(results);
    // Exactly one of them got that stretch of chair B.
    expect([moveStatus === 200, bookStatus === 201].filter(Boolean)).toHaveLength(1);
    const onB = await prisma.appointment.count({
      where: {
        staffId: chairB,
        status: "BOOKED",
        startsAt: { lt: at(17 * 60) },
        endsAt: { gt: at(16 * 60 + 30) },
      },
    });
    expect(onB).toBe(1);
  });
});

describe("🔴 3. once the visit has started, the client cannot cancel or move everyone", () => {
  /** The party, re-timed so the first member is in the chair right now. */
  async function startedParty() {
    const res = await createParty();
    const [first, second] = await members(res.body.groupId);
    const now = Date.now();
    await prisma.appointment.update({
      where: { id: first!.id },
      data: { startsAt: new Date(now - 10 * MIN), endsAt: new Date(now + 20 * MIN) },
    });
    await prisma.appointment.update({
      where: { id: second!.id },
      data: { startsAt: new Date(now + 20 * MIN), endsAt: new Date(now + 40 * MIN) },
    });
    return { token: res.body.manageToken as string, groupId: res.body.groupId as string, first: first!, second: second! };
  }

  it("cancel-everyone and move-everyone are refused; nothing changes", async () => {
    const p = await startedParty();

    const cancel = await request(app).post(`/api/book/group/${p.token}/cancel`);
    expect(cancel.status).toBe(409);
    expect(cancel.body.error).toBe("not_cancelable");
    const move = await request(app)
      .post(`/api/book/group/${p.token}/reschedule`)
      .send({ startsAt: at(16 * 60).toISOString() });
    expect(move.status).toBe(409);
    expect(move.body.error).toBe("not_reschedulable");

    expect((await members(p.groupId)).map((r) => r.status)).toEqual(["BOOKED", "BOOKED"]);
    const group = await prisma.appointmentGroup.findUniqueOrThrow({ where: { id: p.groupId } });
    expect(group.status).toBe("ACTIVE");

    // The page is told, per member too.
    const view = await request(app).get(`/api/book/group/${p.token}`);
    expect(view.body.started).toBe(true);
    expect(view.body.members.map((m: { started: boolean }) => m.started)).toEqual([true, false]);
  });

  it("a member still to come can still be cancelled on their own, and the SHOP's cancel keeps its powers", async () => {
    const p = await startedParty();

    const own = await request(app).post(`/api/book/manage/${p.second.manageToken}/cancel`).send({});
    expect(own.status).toBe(200);

    // The shop cancels the member already in the chair - its own tools are
    // not bound by the client's past-time rule.
    const shop = await dashboard(`/appointments/${p.first.id}/cancel`);
    expect(shop.status).toBe(200);
    expect((await members(p.groupId)).map((r) => r.status)).toEqual(["CANCELED", "CANCELED"]);
  });
});
