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
