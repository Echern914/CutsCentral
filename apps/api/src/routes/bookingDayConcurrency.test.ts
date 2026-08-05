import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * GET /api/book/:slug/day — concurrent callers share ONE sweep.
 *
 * The day cache holds only FINISHED bodies, so a burst of visitors landing on
 * the same date each used to run their own full service x staff sweep. Measured
 * on prod: three simultaneous requests for one uncached day took 5.7s / 6.2s /
 * 7.4s, each doing the whole job — the shape that starves a fixed connection
 * pool exactly when a shop's link gets shared. This pins the dedupe, and that
 * the in-flight entry is released afterwards (a leak would serve one stale
 * promise forever).
 *
 * DAY_TTL_MS is 0 under vitest, so these genuinely race the cold path instead
 * of all reading one cached body.
 */
const app = createApp();

const userIds: string[] = [];

/** UTC shop, open every weekday 09:00-17:00, with `serviceCount` services. */
async function makeShop(slug: string, serviceCount: number) {
  const user = await prisma.user.create({
    data: { email: `dayc-${randomToken(6)}@test.chairback`.toLowerCase(), name: "D" },
    select: { id: true },
  });
  userIds.push(user.id);
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Day Concurrency",
      slug,
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: "UTC",
      bookingLeadHours: 0,
      bookingMaxDays: 60,
    },
    select: { id: true },
  });
  const staff = await prisma.staff.create({
    data: { shopId: shop.id, name: "Sam" },
    select: { id: true },
  });
  for (let i = 0; i < serviceCount; i++) {
    const service = await prisma.service.create({
      data: { shopId: shop.id, name: `Cut ${i}`, durationMin: 30, price: 30 },
      select: { id: true },
    });
    await prisma.serviceStaff.create({
      data: { shopId: shop.id, serviceId: service.id, staffId: staff.id },
    });
  }
  await prisma.availabilityRule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      shopId: shop.id,
      staffId: staff.id,
      weekday,
      startMin: 9 * 60,
      endMin: 17 * 60,
    })),
  });
  return shop.id;
}

/** A date a few days out, so the whole 09:00-17:00 window is in the future. */
function futureDayKey(daysAhead: number): string {
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysAhead),
  )
    .toISOString()
    .slice(0, 10);
}

afterAll(async () => {
  for (const id of userIds) {
    await prisma.shop.deleteMany({ where: { ownerId: id } });
    await prisma.user.delete({ where: { id } });
  }
  await prisma.$disconnect();
});

describe("GET /api/book/:slug/day concurrency", () => {
  it("serves concurrent cold callers one identical body, and recovers after", async () => {
    const slug = `dayc-a-${randomToken(5)}`.toLowerCase();
    await makeShop(slug, 3);
    const date = futureDayKey(3);

    const [a, b, c] = await Promise.all([
      request(app).get(`/api/book/${slug}/day?date=${date}`),
      request(app).get(`/api/book/${slug}/day?date=${date}`),
      request(app).get(`/api/book/${slug}/day?date=${date}`),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(c.body).toEqual(a.body);
    // A real answer, not a shared empty.
    const services = [
      ...a.body.bundles.flatMap((g: { services: unknown[] }) => g.services),
      ...a.body.ungrouped,
    ];
    expect(services.length).toBe(3);

    // In-flight entry released: a later request still computes a real answer.
    const after = await request(app).get(`/api/book/${slug}/day?date=${date}`);
    expect(after.status).toBe(200);
    expect(after.body).toEqual(a.body);
  });

  it("keeps different dates independent while sharing per date", async () => {
    const slug = `dayc-b-${randomToken(5)}`.toLowerCase();
    await makeShop(slug, 2);
    const d1 = futureDayKey(4);
    const d2 = futureDayKey(5);

    // Two dates racing at once: each must get ITS OWN day's body, not the
    // other's — the in-flight map is keyed by shop|date, not by shop.
    const [a1, a2, b1, b2] = await Promise.all([
      request(app).get(`/api/book/${slug}/day?date=${d1}`),
      request(app).get(`/api/book/${slug}/day?date=${d1}`),
      request(app).get(`/api/book/${slug}/day?date=${d2}`),
      request(app).get(`/api/book/${slug}/day?date=${d2}`),
    ]);
    expect(a1.body.date).toBe(d1);
    expect(a2.body.date).toBe(d1);
    expect(b1.body.date).toBe(d2);
    expect(b2.body.date).toBe(d2);
    expect(a2.body).toEqual(a1.body);
    expect(b2.body).toEqual(b1.body);
  });
});
