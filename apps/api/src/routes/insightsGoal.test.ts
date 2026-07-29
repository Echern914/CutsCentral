import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Insights quota goal: PUT/GET/DELETE /api/insights/goal + the progress math.
 * Progress derives from COMPLETED Visits (same source as the Insights totals):
 * revenue goals sum Visit.price (unpriced visits contribute $0 but count as
 * visits), visit goals count rows. Pace = straight-line target across the
 * shop-local period.
 */
const app = createApp();
const password = "supersecret123";
let cookie: string;
let shopId: string;
let clientId: string;
const emails: string[] = [];

async function signup(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Goal Tester", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

const getGoal = () => request(app).get("/api/insights/goal").set("Cookie", cookie);
const putGoal = (body: Record<string, unknown>) =>
  request(app).put("/api/insights/goal").set("Cookie", cookie).send(body);

/** A COMPLETED visit `hoursAgo` hours back (safely inside week AND month). */
async function seedVisit(price: number | null, hoursAgo = 1) {
  await prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `goal-${randomToken(6)}`,
      status: "COMPLETED",
      scheduledAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
      endAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000 + 30 * 60 * 1000),
      completedAt: new Date(),
      price,
    },
  });
}

beforeAll(async () => {
  const email = `goal-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  cookie = await signup(email);
  await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Goal Cuts", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC" });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  shopId = me.body.id as string;
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `goal-${randomToken(6)}`,
      magicToken: randomToken(),
      firstName: "Regular",
    },
    select: { id: true },
  });
  clientId = client.id;
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

describe("insights quota goal", () => {
  it("no goal yet: GET returns nulls", async () => {
    const res = await getGoal();
    expect(res.status).toBe(200);
    expect(res.body.goal).toBeNull();
    expect(res.body.progress).toBeNull();
  });

  it("rejects a bad target", async () => {
    expect((await putGoal({ metric: "revenue", period: "month", target: 0 })).status).toBe(400);
    expect((await putGoal({ metric: "cuts", period: "month", target: 10 })).status).toBe(400);
  });

  it("revenue goal: actual sums COMPLETED visit prices; pace + series are sane", async () => {
    await seedVisit(40);
    await seedVisit(35);
    await seedVisit(null); // unpriced: counts as a visit, adds $0
    await prisma.visit.create({
      // CANCELED never counts.
      data: {
        shopId,
        clientId,
        acuityAppointmentId: `goal-${randomToken(6)}`,
        status: "CANCELED",
        scheduledAt: new Date(),
        canceledAt: new Date(),
        price: 500,
      },
    });

    expect((await putGoal({ metric: "revenue", period: "month", target: 4000 })).status).toBe(200);
    const res = await getGoal();
    expect(res.status).toBe(200);
    expect(res.body.goal).toEqual({ metric: "revenue", period: "month", target: 4000 });
    const p = res.body.progress;
    expect(p.actual).toBe(75);
    expect(p.totalDays).toBeGreaterThanOrEqual(28);
    expect(p.elapsedDays).toBeGreaterThanOrEqual(1);
    expect(p.elapsedDays).toBeLessThanOrEqual(p.totalDays);
    expect(p.daysLeft).toBe(p.totalDays - p.elapsedDays);
    // Straight-line pace for the elapsed fraction of the month.
    expect(p.paceTarget).toBe(Math.round((4000 * p.elapsedDays) / p.totalDays));
    expect(p.delta).toBe(p.actual - p.paceTarget);
    expect(p.pct).toBeCloseTo(75 / 4000, 5);
    // Series: one point per period day; cumulative reaches `actual` at today
    // and is null for future days.
    expect(p.series).toHaveLength(p.totalDays);
    expect(p.series[p.elapsedDays - 1].cumulative).toBe(75);
    if (p.elapsedDays < p.totalDays) {
      expect(p.series[p.elapsedDays].cumulative).toBeNull();
    }
  });

  it("visit-count goal counts every completed visit, priced or not", async () => {
    expect((await putGoal({ metric: "visits", period: "week", target: 60 })).status).toBe(200);
    const res = await getGoal();
    expect(res.body.goal.metric).toBe("visits");
    expect(res.body.goal.period).toBe("week");
    expect(res.body.progress.actual).toBe(3); // the three COMPLETED seeds
    expect(res.body.progress.totalDays).toBe(7);
  });

  it("DELETE clears the goal (idempotent)", async () => {
    expect(
      (await request(app).delete("/api/insights/goal").set("Cookie", cookie)).status,
    ).toBe(200);
    expect((await getGoal()).body.goal).toBeNull();
    expect(
      (await request(app).delete("/api/insights/goal").set("Cookie", cookie)).status,
    ).toBe(200);
  });
});
