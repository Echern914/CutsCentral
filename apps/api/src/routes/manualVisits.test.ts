import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

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
