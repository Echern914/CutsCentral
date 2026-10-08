import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedDateParts, zonedWallTimeToUtc } from "@chairback/config";
import { createApp } from "../app.js";
import { raceBehindRowLock } from "../testing/raceBarrier.js";

/**
 * Manual visit logging - the no-Acuity path. A logged visit must behave
 * exactly like an ingested one: real Visit row, punches via the earn engine
 * (earn rules included), and cadence/at-risk fields recomputed.
 */
const app = createApp();
// Lowercased: signup normalizes email, randomToken can emit uppercase.
const emailA = `mv-a-${randomToken(6)}@test.local`.toLowerCase();
const emailB = `mv-b-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookieA: string;
let cookieB: string;
let clientId: string;

const DAY = 86_400_000;

async function signupAndShop(email: string, shopName: string): Promise<string> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Manual Visits", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: shopName, bookingUrl: "https://manual.test", smsAttested: true });
  expect(shop.status).toBe(201);
  // Rewards are opt-IN for new shops (default off); this suite exercises loyalty.
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ rewardsEnabled: true });
  return cookie;
}

beforeAll(async () => {
  cookieA = await signupAndShop(emailA, "Manual Cuts A");
  cookieB = await signupAndShop(emailB, "Manual Cuts B");
  const created = await request(app)
    .post("/api/dashboard/clients")
    .set("Cookie", cookieA)
    .send({ firstName: "Walkin" });
  expect(created.status).toBe(201);
  clientId = created.body.id;
});

afterAll(async () => {
  for (const email of [emailA, emailB]) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("manual visit logging", () => {
  it("logs a visit and earns a punch", async () => {
    const res = await request(app)
      .post(`/api/dashboard/clients/${clientId}/visits`)
      .set("Cookie", cookieA)
      .send({ serviceName: "Walk-in cut" });
    expect(res.status).toBe(201);
    expect(res.body.balance).toBe(1);

    const detail = await request(app)
      .get(`/api/dashboard/clients/${clientId}`)
      .set("Cookie", cookieA);
    expect(detail.body.visits).toHaveLength(1);
    expect(detail.body.visits[0].status).toBe("COMPLETED");
    expect(detail.body.client.lastVisitAt).not.toBeNull();
  });

  it("backdated second visit establishes a cadence", async () => {
    const threeWeeksAgo = new Date(Date.now() - 21 * DAY).toISOString();
    const res = await request(app)
      .post(`/api/dashboard/clients/${clientId}/visits`)
      .set("Cookie", cookieA)
      .send({ when: threeWeeksAgo });
    expect(res.status).toBe(201);
    expect(res.body.balance).toBe(2);

    const detail = await request(app)
      .get(`/api/dashboard/clients/${clientId}`)
      .set("Cookie", cookieA);
    // Two completed visits 21 days apart -> median interval = 21.
    expect(detail.body.client.medianIntervalDays).toBe(21);
    // lastVisitAt must stay the NEWER visit despite the backdated insert.
    const last = new Date(detail.body.client.lastVisitAt).getTime();
    expect(Date.now() - last).toBeLessThan(DAY);
  });

  it("same-day visits produce NO cadence (median 0 must not mean instantly-overdue)", async () => {
    const created = await request(app)
      .post("/api/dashboard/clients")
      .set("Cookie", cookieA)
      .send({ firstName: "Sameday" });
    expect(created.status).toBe(201);
    const when = new Date(Date.now() - 2 * DAY).toISOString();
    for (let i = 0; i < 2; i++) {
      const res = await request(app)
        .post(`/api/dashboard/clients/${created.body.id}/visits`)
        .set("Cookie", cookieA)
        .send({ when });
      expect(res.status).toBe(201);
    }
    const detail = await request(app)
      .get(`/api/dashboard/clients/${created.body.id}`)
      .set("Cookie", cookieA);
    // Regression: this used to store 0, which made the client "deeply lapsed"
    // one day later and win-back-textable the day after they were just in.
    expect(detail.body.client.medianIntervalDays).toBeNull();
  });

  it("respects earn rules for the logged service", async () => {
    const rule = await request(app)
      .post("/api/loyalty/rules")
      .set("Cookie", cookieA)
      .send({ serviceMatch: "deluxe", punches: 3 });
    expect(rule.status).toBe(201);

    const res = await request(app)
      .post(`/api/dashboard/clients/${clientId}/visits`)
      .set("Cookie", cookieA)
      .send({ serviceName: "Deluxe Package" });
    expect(res.status).toBe(201);
    expect(res.body.balance).toBe(5); // 2 + 3
  });

  it("rejects future dates", async () => {
    const res = await request(app)
      .post(`/api/dashboard/clients/${clientId}/visits`)
      .set("Cookie", cookieA)
      .send({ when: new Date(Date.now() + DAY).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("future_visit");
  });

  it("another shop cannot log visits on my client", async () => {
    const res = await request(app)
      .post(`/api/dashboard/clients/${clientId}/visits`)
      .set("Cookie", cookieB)
      .send({});
    expect(res.status).toBe(404);
  });
});

/**
 * 🔴 ONE SITTING, ONE PUNCH. Two ways a single cut earned twice through Log
 * visit, neither of them a code error a person could see:
 *  - the request was sent again (a retry after a dropped response, a second
 *    tap) and each copy logged its own visit;
 *  - the cut was already on the books - a ChairBack booking that earns when it
 *    is done, or an Acuity/Square visit that earns when it ends - and was then
 *    logged again by hand.
 */
describe("🔴 Log visit cannot credit one sitting twice", () => {
  const TZ = "America/New_York"; // the shop default; set explicitly below
  let shopId: string;
  let staffId: string;
  let serviceId: string;

  /** Shop-local h:00 on the day `daysAgo` days back. */
  function localAt(daysAgo: number, hour: number): Date {
    const p = zonedDateParts(new Date(Date.now() - daysAgo * DAY), TZ);
    return zonedWallTimeToUtc(p.year, p.month0, p.day, hour * 60, TZ);
  }

  async function newClient(firstName: string): Promise<string> {
    const res = await request(app)
      .post("/api/dashboard/clients")
      .set("Cookie", cookieA)
      .send({ firstName });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  /** Every punch this client earned from a visit (the ledger, not the screen). */
  async function visitEarns(id: string): Promise<number> {
    const rows = await prisma.punchLedger.findMany({
      where: { shopId, clientId: id, visitId: { not: null }, reversalOfId: null },
      select: { punchesEarned: true },
    });
    return rows.reduce((s, r) => s + r.punchesEarned, 0);
  }

  const logVisit = (id: string, body: Record<string, unknown>) =>
    request(app).post(`/api/dashboard/clients/${id}/visits`).set("Cookie", cookieA).send(body);

  beforeAll(async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: emailA } });
    const shop = await prisma.shop.findFirstOrThrow({ where: { ownerId: owner.id }, select: { id: true } });
    shopId = shop.id;
    await prisma.shop.update({ where: { id: shopId }, data: { timezone: TZ } });
    staffId = (await prisma.staff.create({ data: { shopId, name: "Mo" }, select: { id: true } })).id;
    serviceId = (
      await prisma.service.create({
        data: { shopId, name: "Haircut", durationMin: 45, price: 40 },
        select: { id: true },
      })
    ).id;
  });

  it("the same tap sent twice logs ONE visit and ONE punch; the retry reports the first", async () => {
    const id = await newClient("Retry");
    const requestId = `tap-${randomToken(16)}`;
    const first = await logVisit(id, { requestId });
    expect(first.status).toBe(201);
    const again = await logVisit(id, { requestId });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.visitId).toBe(first.body.visitId);
    expect(again.body.balance).toBe(1);

    expect(await prisma.visit.count({ where: { shopId, clientId: id } })).toBe(1);
    expect(await visitEarns(id)).toBe(1);
  });

  it("a tap's id reused on a different client is refused, and logs nothing", async () => {
    const a = await newClient("First");
    const b = await newClient("Second");
    const requestId = `tap-${randomToken(16)}`;
    expect((await logVisit(a, { requestId })).status).toBe(201);
    const reused = await logVisit(b, { requestId });
    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe("request_reused");
    expect(await prisma.visit.count({ where: { shopId, clientId: b } })).toBe(0);
  });

  it("a malformed requestId is a 400, not a visit", async () => {
    const id = await newClient("Malformed");
    const res = await logVisit(id, { requestId: "short" });
    expect(res.status).toBe(400);
    expect(await prisma.visit.count({ where: { shopId, clientId: id } })).toBe(0);
  });

  it("🔴 a retry racing the first try (behind the client lock) still logs one visit", async () => {
    const id = await newClient("Racer");
    const requestId = `tap-${randomToken(16)}`;
    const { results, settledEarly } = await raceBehindRowLock("Client", id, [
      () => logVisit(id, { requestId }).then((r) => r.status),
      () => logVisit(id, { requestId }).then((r) => r.status),
    ]);
    expect(settledEarly).toBe(0);
    const statuses = results
      .filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled")
      .map((r) => r.value)
      .sort();
    expect(statuses).toEqual([200, 201]);
    expect(await prisma.visit.count({ where: { shopId, clientId: id } })).toBe(1);
    expect(await visitEarns(id)).toBe(1);
  });

  it("🔴 a client with a ChairBack booking that day is asked about first - nothing is written", async () => {
    const id = await newClient("Booked");
    const starts = localAt(2, 14);
    await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        clientId: id,
        firstName: "Booked",
        status: "BOOKED",
        startsAt: starts,
        endsAt: new Date(starts.getTime() + 45 * 60_000),
        manageToken: randomToken(),
      },
    });
    // Logged at 3:30pm the same shop-local day - the same cut, by another door.
    const res = await logVisit(id, { when: localAt(2, 15).toISOString() });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("visit_on_books");
    expect(res.body.existing).toEqual({ at: starts.toISOString(), serviceName: "Haircut", source: "booking" });
    expect(await prisma.visit.count({ where: { shopId, clientId: id } })).toBe(0);
    expect(await visitEarns(id)).toBe(0);

    // The barber says it really was a separate visit: that is theirs to log.
    const separate = await logVisit(id, { when: localAt(2, 15).toISOString(), separateVisit: true });
    expect(separate.status).toBe(201);
    expect(await visitEarns(id)).toBe(1);
  });

  it("a finished booking (its visit is on file) and a synced Acuity visit are asked about too", async () => {
    const done = await newClient("Done");
    await prisma.visit.create({
      data: {
        shopId,
        clientId: done,
        acuityAppointmentId: `booking:${randomToken(8)}`,
        status: "COMPLETED",
        scheduledAt: localAt(3, 11),
        endAt: localAt(3, 12),
        completedAt: localAt(3, 12),
        serviceName: "Haircut",
      },
    });
    const a = await logVisit(done, { when: localAt(3, 18).toISOString() });
    expect(a.status).toBe(409);
    expect(a.body.existing.source).toBe("booking");

    const synced = await newClient("Synced");
    await prisma.visit.create({
      data: {
        shopId,
        clientId: synced,
        acuityAppointmentId: String(Math.floor(Math.random() * 1e9) + 1e9),
        status: "SCHEDULED",
        scheduledAt: localAt(3, 10),
        endAt: localAt(3, 11),
        serviceName: "Fade",
      },
    });
    const b = await logVisit(synced, { when: localAt(3, 9).toISOString() });
    expect(b.status).toBe(409);
    expect(b.body.existing).toMatchObject({ serviceName: "Fade", source: "synced" });
  });

  it("a cancelled booking, or a booking on another day, does not stand in the way", async () => {
    const id = await newClient("Clear");
    const starts = localAt(4, 14);
    await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        clientId: id,
        firstName: "Clear",
        status: "CANCELED",
        canceledAt: new Date(),
        startsAt: starts,
        endsAt: new Date(starts.getTime() + 45 * 60_000),
        manageToken: randomToken(),
      },
    });
    const yesterday = localAt(5, 14);
    await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        clientId: id,
        firstName: "Clear",
        status: "BOOKED",
        startsAt: yesterday,
        endsAt: new Date(yesterday.getTime() + 45 * 60_000),
        manageToken: randomToken(),
      },
    });
    const res = await logVisit(id, { when: localAt(4, 16).toISOString() });
    expect(res.status).toBe(201);
    expect(await visitEarns(id)).toBe(1);
  });
});
