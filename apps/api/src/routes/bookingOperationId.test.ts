import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { raceBehindAdvisoryLock } from "../testing/raceBarrier.js";

/**
 * 🔴 ONE SUBMISSION, ONE BOOKING (POST /api/booking/appointments).
 *
 * "Book again" books a client's next visit while they are still in the chair,
 * often on a shop's patchy wifi. A submission whose answer was lost used to
 * come back, when re-sent, as a refusal naming the barber's OWN new booking as
 * the conflict - with "Book anyway" offered, which books it twice. An
 * operationId (one per submission, re-sent on every retry of it) makes the
 * retry return the booking the first copy made.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
let cookie: string;
let cookieB: string;
let shopId: string;
let staffId: string;
let serviceId: string;

function tomorrowAt(hourUtc: number, minute = 0): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d.toISOString();
}

const opId = () => `op-${randomToken(16)}`;

function book(body: Record<string, unknown>, as = cookie) {
  return request(app)
    .post("/api/booking/appointments")
    .set("Cookie", as)
    .send({ staffId, serviceId, ...body });
}

async function signup(name: string): Promise<string> {
  const email = `opid-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name, smsAttested: true });
  expect(res.status).toBe(201);
  const c = (res.headers["set-cookie"] as unknown as string[])[0]!;
  await request(app).post("/api/shops").set("Cookie", c).send({ name: `${name} Cuts`, smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", c)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  return c;
}

beforeAll(async () => {
  cookie = await signup("Op");
  cookieB = await signup("Other");
  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Mo" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 40, staffIds: [staffId] });
  serviceId = service.body.id;
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 }));
  await request(app).put(`/api/booking/staff/${staffId}/availability`).set("Cookie", cookie).send({ rules });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  shopId = me.body.id;
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("🔴 a retried submission returns the booking it made", () => {
  it("the same operationId twice: one booking, and the retry is told about it", async () => {
    const operationId = opId();
    const first = await book({ startsAt: tomorrowAt(10), firstName: "Retry", operationId });
    expect(first.status).toBe(201);
    const again = await book({ startsAt: tomorrowAt(10), firstName: "Retry", operationId });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, id: first.body.id, replayed: true });
    expect(await prisma.appointment.count({ where: { shopId, firstName: "Retry" } })).toBe(1);
  });

  it("🔴 a retry still gets its booking when the time would no longer pass the slot rules", async () => {
    // The first copy landed at 4:00 PM. Before the retry arrives the barber
    // shortens his day to 3:00 PM, so the slot rules - checked before any
    // write - now refuse that time. Only the read that comes BEFORE them can
    // answer the retry with the booking it already made.
    const operationId = opId();
    const first = await book({ startsAt: tomorrowAt(16), firstName: "Late", operationId });
    expect(first.status).toBe(201);
    const short = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 15 * 60 }));
    await request(app).put(`/api/booking/staff/${staffId}/availability`).set("Cookie", cookie).send({ rules: short });
    try {
      const again = await book({ startsAt: tomorrowAt(16), firstName: "Late", operationId });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ id: first.body.id, replayed: true });
    } finally {
      const full = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 }));
      await request(app).put(`/api/booking/staff/${staffId}/availability`).set("Cookie", cookie).send({ rules: full });
    }
  });

  it("a DIFFERENT submission for the same time is still refused - it names the booking in the way", async () => {
    const one = await book({ startsAt: tomorrowAt(11), firstName: "First", operationId: opId() });
    expect(one.status).toBe(201);
    const other = await book({ startsAt: tomorrowAt(11), firstName: "Second", customTime: true, operationId: opId() });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe("OVERLAP");
  });

  it("🔴 two copies racing (behind the barber's booking lock): one booking, both answered with it", async () => {
    const operationId = opId();
    const { results, settledEarly } = await raceBehindAdvisoryLock(`appt:${staffId}`, [
      () => book({ startsAt: tomorrowAt(12), firstName: "Racer", operationId }),
      () => book({ startsAt: tomorrowAt(12), firstName: "Racer", operationId }),
    ]);
    expect(settledEarly).toBe(0);
    const answers = results
      .filter((r): r is PromiseFulfilledResult<request.Response> => r.status === "fulfilled")
      .map((r) => r.value);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 201]);
    expect(new Set(answers.map((a) => a.body.id)).size).toBe(1);
    expect(await prisma.appointment.count({ where: { shopId, firstName: "Racer" } })).toBe(1);
  });

  it("a retry after the booking was cancelled is NOT reported as booked", async () => {
    const operationId = opId();
    const made = await book({ startsAt: tomorrowAt(13), firstName: "Gone", operationId });
    expect(made.status).toBe(201);
    await prisma.appointment.update({
      where: { id: made.body.id },
      data: { status: "CANCELED", canceledAt: new Date() },
    });
    const again = await book({ startsAt: tomorrowAt(13), firstName: "Gone", operationId });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("replay_not_booked");
    expect(await prisma.appointment.count({ where: { shopId, firstName: "Gone" } })).toBe(1);
  });

  it("an operationId belongs to its shop: another shop's id is just a new booking there", async () => {
    const operationId = opId();
    expect((await book({ startsAt: tomorrowAt(14), firstName: "Mine", operationId })).status).toBe(201);
    // Shop B has its own staff and service; the same id must not reach shop A's booking.
    const staffB = await request(app).post("/api/booking/staff").set("Cookie", cookieB).send({ name: "Bee" });
    const svcB = await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookieB)
      .send({ name: "Fade", durationMin: 30, price: 30, staffIds: [staffB.body.id] });
    const theirs = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookieB)
      .send({
        staffId: staffB.body.id,
        serviceId: svcB.body.id,
        startsAt: tomorrowAt(14),
        firstName: "Theirs",
        customTime: true,
        operationId,
      });
    expect(theirs.status).toBe(201);
    expect(theirs.body.replayed).toBeUndefined();
    expect(theirs.body.id).not.toBe(undefined);
  });

  it("a repeating series takes no operationId (it answers per visit)", async () => {
    const res = await book({
      startsAt: tomorrowAt(15),
      firstName: "Series",
      operationId: opId(),
      recurrence: { interval: 1, count: 2 },
    });
    expect(res.status).toBe(400);
  });
});

/**
 * 🔴 THE SAVED BOOKING, NOT THE SCREEN. A retry is answered from what its id
 * actually booked - and refused when it now asks for something else, or when
 * that booking's calendar protection has not settled.
 */
describe("🔴 a retry is answered from the saved booking", () => {
  let staff2: string;
  let both: string; // a service both providers offer
  let clientA: string;
  let clientB: string;

  beforeAll(async () => {
    staff2 = (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" })).body.id;
    both = (
      await request(app)
        .post("/api/booking/services")
        .set("Cookie", cookie)
        .send({ name: "Beard", durationMin: 30, price: 20, staffIds: [staffId, staff2] })
    ).body.id;
    const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 }));
    await request(app).put(`/api/booking/staff/${staff2}/availability`).set("Cookie", cookie).send({ rules });
    clientA = (await request(app).post("/api/dashboard/clients").set("Cookie", cookie).send({ firstName: "Ana" })).body.id;
    clientB = (await request(app).post("/api/dashboard/clients").set("Cookie", cookie).send({ firstName: "Bo" })).body.id;
  });

  /** Book with an existing client, as Book again does. */
  const again = (operationId: string, over: Record<string, unknown> = {}) =>
    book({ startsAt: tomorrowAt(9), serviceId: both, clientId: clientA, customTime: true, operationId, ...over });

  const cancel = (id: string) =>
    prisma.appointment.update({ where: { id }, data: { status: "CANCELED", canceledAt: new Date() } });

  it("the first answer and a replay both carry the SAVED start and end", async () => {
    const operationId = opId();
    const first = await again(operationId);
    expect(first.status).toBe(201);
    expect(first.body.startsAt).toBe(tomorrowAt(9));
    const replay = await again(operationId);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ id: first.body.id, startsAt: tomorrowAt(9), replayed: true, mirror: "skipped" });
    expect(replay.body.endsAt).toBe(first.body.endsAt);
    await cancel(first.body.id);
  });

  const changes: Array<[string, () => Record<string, unknown>]> = [
    ["the day", () => ({ startsAt: tomorrowAt(15) })],
    ["the service", () => ({ serviceId })],
    ["the provider", () => ({ staffId: staff2 })],
    ["the client", () => ({ clientId: clientB })],
  ];
  for (const [change, over] of changes) {
    it(`🔴 lost answer, then ${change} changed: refused, naming what WAS booked - nothing new is booked`, async () => {
      const operationId = opId();
      const first = await again(operationId);
      expect(first.status).toBe(201);
      const before = await prisma.appointment.count({ where: { shopId } });

      const changed = await again(operationId, over());
      expect(changed.status).toBe(409);
      expect(changed.body.error).toBe("operation_mismatch");
      expect(changed.body.booked).toMatchObject({ id: first.body.id, startsAt: tomorrowAt(9) });
      expect(await prisma.appointment.count({ where: { shopId } })).toBe(before);
      await cancel(first.body.id);
    });
  }

  it("an id reused with different add-ons is not the same request either", async () => {
    const addOn = await request(app)
      .post("/api/booking/addons")
      .set("Cookie", cookie)
      .send({ name: "Hot towel", durationMin: 0, price: 5, serviceIds: [both] });
    expect(addOn.status).toBe(201);
    const operationId = opId();
    const first = await again(operationId);
    expect(first.status).toBe(201);
    const withAddOn = await again(operationId, { addOnIds: [addOn.body.id ?? addOn.body.addOn?.id] });
    expect(withAddOn.status).toBe(409);
    expect(withAddOn.body.error).toBe("operation_mismatch");
    await cancel(first.body.id);
  });

  async function withBlock(appointmentId: string, state: "PENDING" | "ACTIVE" | "UNKNOWN" | "FAILED") {
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    const row = await prisma.acuityOutboundBlock.create({
      data: {
        shopId,
        appointmentId,
        staffId: appt.staffId,
        acuityCalendarId: `cal-${randomToken(4)}`,
        startsAt: appt.startsAt,
        endsAt: appt.endsAt,
        state,
      },
      select: { id: true },
    });
    return row.id;
  }
  const age = (blockId: string, ms: number) =>
    prisma.$executeRaw`UPDATE "AcuityOutboundBlock" SET "updatedAt" = ${new Date(Date.now() - ms).toISOString()}::timestamp WHERE id = ${blockId}`;

  it("🔴 a retry while the calendar block is still PENDING is told it is in progress - not booked", async () => {
    const operationId = opId();
    const first = await again(operationId);
    const block = await withBlock(first.body.id, "PENDING");
    const replay = await again(operationId);
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({
      error: "operation_in_progress",
      booked: { id: first.body.id, startsAt: tomorrowAt(9) },
    });

    // Once the block lands, the same retry is answered with the booking and its protection.
    await prisma.acuityOutboundBlock.update({ where: { id: block }, data: { state: "ACTIVE" } });
    const settled = await again(operationId);
    expect(settled.status).toBe(200);
    expect(settled.body).toMatchObject({ id: first.body.id, mirror: "active", replayed: true });
    await cancel(first.body.id);
  });

  it("an UNCERTAIN block replays as uncertain, never as protected", async () => {
    const operationId = opId();
    const first = await again(operationId);
    await withBlock(first.body.id, "UNKNOWN");
    const replay = await again(operationId);
    expect(replay.status).toBe(200);
    expect(replay.body.mirror).toBe("unknown");
    await cancel(first.body.id);
  });

  it("🔴 a FORCED booking whose block just failed is mid-undo: in progress; long settled: booked, failed", async () => {
    const operationId = opId();
    const first = await again(operationId);
    await prisma.appointment.update({ where: { id: first.body.id }, data: { overlapForcedAt: new Date() } });
    const block = await withBlock(first.body.id, "FAILED");
    const fresh = await again(operationId);
    expect(fresh.status).toBe(409);
    expect(fresh.body.error).toBe("operation_in_progress");

    // The undo never ran (it could not): the booking stands, and says so.
    await age(block, 10 * 60_000);
    const later = await again(operationId);
    expect(later.status).toBe(200);
    expect(later.body).toMatchObject({ forced: true, mirror: "failed" });

    // The undo DID run: never reported as booked.
    await cancel(first.body.id);
    const undone = await again(operationId);
    expect(undone.status).toBe(409);
    expect(undone.body.error).toBe("replay_not_booked");
  });

  it("an operation id is refused with a client confirmation (a replay could only re-send the push)", async () => {
    const res = await again(opId(), { confirmClient: true });
    expect(res.status).toBe(400);
  });
});
