import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Barber visit edit/delete through the HTTP surface. Covers the route-layer logic
 * the service tests don't reach: reason -> HTTP-status mapping (404 vs 409 vs
 * 400), the future-date guard, the punch-balance side effects of editing/deleting
 * a COMPLETED visit, and that one shop can never touch another's visit.
 */
const app = createApp();
const emailA = `vis-a-${randomToken(6)}@test.local`.toLowerCase();
const emailB = `vis-b-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookieA: string;
let cookieB: string;
let clientId: string;

async function signupAndShop(email: string, shopName: string): Promise<string> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Visit Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: shopName, bookingUrl: "https://visit.test", smsAttested: true });
  expect(shop.status).toBe(201);
  return cookie;
}

/** Log a COMPLETED manual visit; returns its id. */
async function logVisit(cookie: string, serviceName?: string): Promise<string> {
  const res = await request(app)
    .post(`/api/dashboard/clients/${clientId}/visits`)
    .set("Cookie", cookie)
    .send(serviceName ? { serviceName } : {});
  expect(res.status).toBe(201);
  return res.body.visitId as string;
}

async function balance(cookie: string): Promise<number> {
  const res = await request(app)
    .get(`/api/dashboard/clients/${clientId}/ledger`)
    .set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body.balance as number;
}

beforeAll(async () => {
  cookieA = await signupAndShop(emailA, "Visit Cuts A");
  cookieB = await signupAndShop(emailB, "Visit Cuts B");
  const created = await request(app)
    .post("/api/dashboard/clients")
    .set("Cookie", cookieA)
    .send({ firstName: "Editable" });
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

describe("visit edit/delete routes", () => {
  it("requires auth", async () => {
    const res = await request(app).delete(
      `/api/dashboard/clients/${clientId}/visits/whatever`,
    );
    expect(res.status).toBe(401);
  });

  it("404s a foreign visit id (cross-tenant isolation)", async () => {
    const visitId = await logVisit(cookieA, "Cut");
    // Shop B trying to delete shop A's visit: the client itself isn't visible to B.
    const res = await request(app)
      .delete(`/api/dashboard/clients/${clientId}/visits/${visitId}`)
      .set("Cookie", cookieB);
    expect(res.status).toBe(404);
    // Clean up.
    await request(app)
      .delete(`/api/dashboard/clients/${clientId}/visits/${visitId}`)
      .set("Cookie", cookieA);
  });

  it("deleting a completed visit claws back its punch", async () => {
    const before = await balance(cookieA);
    const visitId = await logVisit(cookieA, "Standard Cut"); // earns base rate (1)
    expect(await balance(cookieA)).toBe(before + 1);
    const res = await request(app)
      .delete(`/api/dashboard/clients/${clientId}/visits/${visitId}`)
      .set("Cookie", cookieA);
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(before);
    expect(await balance(cookieA)).toBe(before);
  });

  it("rejects a future date on edit", async () => {
    const visitId = await logVisit(cookieA, "Cut");
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .patch(`/api/dashboard/clients/${clientId}/visits/${visitId}`)
      .set("Cookie", cookieA)
      .send({ when: future });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("future_visit");
    await request(app)
      .delete(`/api/dashboard/clients/${clientId}/visits/${visitId}`)
      .set("Cookie", cookieA);
  });

  it("rejects an empty edit body", async () => {
    const visitId = await logVisit(cookieA, "Cut");
    const res = await request(app)
      .patch(`/api/dashboard/clients/${clientId}/visits/${visitId}`)
      .set("Cookie", cookieA)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
    await request(app)
      .delete(`/api/dashboard/clients/${clientId}/visits/${visitId}`)
      .set("Cookie", cookieA);
  });

  it("refuses a delete that would drive the balance negative", async () => {
    // Use a fresh client so the balance math is isolated and deterministic.
    const c = await request(app)
      .post("/api/dashboard/clients")
      .set("Cookie", cookieA)
      .send({ firstName: "Spender" });
    expect(c.status).toBe(201);
    const spenderId = c.body.id as string;

    const logged = await request(app)
      .post(`/api/dashboard/clients/${spenderId}/visits`)
      .set("Cookie", cookieA)
      .send({ serviceName: "Cut" }); // +1 (base rate)
    expect(logged.status).toBe(201);
    const visitId = logged.body.visitId as string;
    expect(logged.body.balance).toBe(1);

    // Spend the single punch via a reward so the visit's punch is consumed.
    const reward = await request(app)
      .post("/api/loyalty/rewards")
      .set("Cookie", cookieA)
      .send({ name: "Free thing", punchCost: 1 });
    expect(reward.status).toBe(201);
    const redeem = await request(app)
      .post(`/api/dashboard/redeem/${spenderId}`)
      .set("Cookie", cookieA)
      .send({ rewardId: reward.body.id });
    expect(redeem.status).toBe(200);

    // Deleting the visit now would push the balance to -1: refused.
    const res = await request(app)
      .delete(`/api/dashboard/clients/${spenderId}/visits/${visitId}`)
      .set("Cookie", cookieA);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("would_go_negative");
  });
});
