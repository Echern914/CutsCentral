import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The barber's view of a client's tier: GET /api/dashboard/clients/:id says
 * where the client stands under the shop's rules NOW and what the next tier
 * still needs - even when the stored badge has not caught up yet.
 */

const app = createApp();
const DAY = 86_400_000;
const emails: string[] = [];
let shopId = "";
let cookie = "";

const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

beforeAll(async () => {
  const email = `standing-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Standing", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Standing Cuts", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  const rules = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({
      tierRules: {
        BRONZE: { visits: { min: 1, windowDays: 0 }, spend: null, match: "all" },
        SILVER: { visits: { min: 3, windowDays: 0 }, spend: null, match: "all" },
        GOLD: { visits: { min: 2, windowDays: 30 }, spend: { minCents: 20_000, windowDays: 0 }, match: "all" },
      },
    });
  expect(rules.status).toBe(200);
});

afterAll(async () => {
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
  for (const email of emails) await prisma.user.deleteMany({ where: { email } });
});

async function clientWith(visits: { daysAgo: number; price: number }[], storedTier: "BRONZE" | "SILVER" | "GOLD" | null) {
  const c = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `k-${randomToken(8)}`,
      magicToken: randomToken(),
      firstName: "Casey",
      source: "manual",
      loyaltyTier: storedTier,
    },
    select: { id: true },
  });
  for (const v of visits) {
    await prisma.visit.create({
      data: {
        shopId,
        clientId: c.id,
        acuityAppointmentId: `a-${randomToken(8)}`,
        scheduledAt: daysAgo(v.daysAgo),
        status: "COMPLETED",
        price: v.price,
      },
    });
  }
  return c.id;
}

describe("GET /api/dashboard/clients/:id - tier", () => {
  it("🔴 the tier under the shop's rules now, not the stored badge that has not caught up", async () => {
    // Stored as Gold (say, before last night's recompute) - but only one visit
    // in the last 30 days, so the rules say Silver today.
    const id = await clientWith(
      [
        { daysAgo: 3, price: 150 },
        { daysAgo: 40, price: 100 },
        { daysAgo: 50, price: 100 },
      ],
      "GOLD",
    );
    const res = await request(app).get(`/api/dashboard/clients/${id}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.client.loyaltyTier).toBe("GOLD");
    expect(res.body.tier).toMatchObject({
      current: "SILVER",
      label: "Silver",
      color: "#C7CBD1",
      next: {
        label: "Gold",
        summary: "1 more visit in the last 30 days to reach Gold",
        requirements: [
          { met: false, text: "1 of 2 visits in the last 30 days" },
          { met: true, text: "$350 spent" },
        ],
      },
    });
  });

  it("a client with nothing yet is told what the first tier takes", async () => {
    const id = await clientWith([], null);
    const res = await request(app).get(`/api/dashboard/clients/${id}`).set("Cookie", cookie);
    expect(res.body.tier).toMatchObject({
      current: null,
      label: null,
      fraction: 0,
      next: { label: "Bronze", summary: "1 more visit to Bronze" },
    });
  });
});
