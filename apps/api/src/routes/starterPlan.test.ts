import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { PLANS, __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { applyStripeEvent } from "../billing/stripe.js";

/**
 * The Starter tier, end to end: it arrives through Stripe like any other
 * tier, it is paid up (no wall, booking page open), and it is NOT Premium -
 * no texts, no AI, no connector, Insights as a sneak peek. Billing is ENABLED
 * for this file (dummy STRIPE_* set before the app is imported), which is what
 * makes every gate real.
 */
const email = `starter-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
const DAY = 86_400_000;
const CUSTOMER_ID = `cus_starter_${randomToken(8)}`;
const SUB_ID = `sub_starter_${randomToken(8)}`;

let app: import("express").Express;
let cookie: string;
let shopId: string;
let slug: string;

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_PRICE_ID = "price_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_starter";
  delete process.env.STRIPE_STARTER_PRICE_ID;
  delete process.env.STRIPE_PREMIUM_AI_PRICE_ID;
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Starter Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Starter Cuts", bookingUrl: "https://starter.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  await prisma.shop.update({
    where: { id: shopId },
    data: { bookingMode: "native", stripeCustomerId: CUSTOMER_ID },
  });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug as string;
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("a Starter subscription", () => {
  it("arrives through Stripe: metadata.tier=starter maps to plan starter", async () => {
    await applyStripeEvent({
      type: "customer.subscription.created",
      data: {
        object: {
          id: SUB_ID,
          status: "active",
          customer: CUSTOMER_ID,
          metadata: { shopId, tier: "starter" },
        },
      },
    } as never);
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    expect(shop!.plan).toBe("starter");
    expect(shop!.subscriptionStatus).toBe("active");
    expect(shop!.stripeSubscriptionId).toBe(SUB_ID);
  });

  it("the Starter checkout is dark until its price is configured", async () => {
    const res = await request(app)
      .post("/api/billing/checkout")
      .set("Cookie", cookie)
      .send({ tier: "starter" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("starter_unavailable");
  });

  describe("once the signup trial is over", () => {
    beforeAll(async () => {
      await prisma.shop.update({
        where: { id: shopId },
        data: { trialEndsAt: new Date(Date.now() - DAY) },
      });
    });

    it("is paid up (no wall) but not Premium, and GET /api/billing says exactly that", async () => {
      const res = await request(app).get("/api/billing").set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body.plan).toBe("starter");
      expect(res.body.hasAccess).toBe(true);
      expect(res.body.subscribed).toBe(true);
      expect(res.body.entitlements).toMatchObject({
        premium: false,
        texts: false,
        insights: "peek",
        receptionist: false,
        connector: false,
      });
      // No texts: the monthly quota is zero, so every marketing sweep budgets 0.
      expect(res.body.smsUsage.quota).toBe(0);
      expect(res.body.starter.priceMonthlyUsd).toBe(PLANS.starter.priceMonthlyUsd);
      expect(res.body.starter.billingEnabled).toBe(false);
    });

    it("keeps the booking page open to customers", async () => {
      const res = await request(app).get(`/api/book/${slug}`);
      expect(res.status).toBe(200);
      expect(res.body.shop.bookingPaused).toBe(false);
    });

    it("gets the Insights sneak peek: headline numbers, none of the analysis", async () => {
      const res = await request(app).get("/api/insights?period=30d").set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body.scope).toBe("peek");
      expect(res.body.buckets).toEqual([]);
      expect(res.body.services).toEqual([]);
      expect(res.body.totals).toMatchObject({ visits: 0, revenue: 0 });
      expect(res.body.busiest).toBeTruthy();

      for (const path of [
        "/api/insights/utilization?period=30d",
        "/api/insights/goal",
        "/api/yearly-report",
      ]) {
        const r = await request(app).get(path).set("Cookie", cookie);
        expect(r.status, path).toBe(402);
        expect(r.body.error, path).toBe("premium_required");
      }
      const put = await request(app).put("/api/insights/goal").set("Cookie", cookie).send({});
      expect(put.status).toBe(402);
      expect(put.body.error).toBe("premium_required");
    });

    it("cannot start the AI trial: Premium first", async () => {
      const res = await request(app).post("/api/billing/ai-trial").set("Cookie", cookie);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("premium_required");
    });

    it("is not entitled to the assistant connector", async () => {
      const res = await request(app).get("/api/mcp/connections").set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body.entitled).toBe(false);
      expect(res.body.connectUrl).toBeNull();
    });

    it("upgrades only UP, and only to a tier that is for sale", async () => {
      // Premium AI is not configured in this suite.
      const ai = await request(app)
        .post("/api/billing/upgrade")
        .set("Cookie", cookie)
        .send({ tier: "pro_ai" });
      expect(ai.status).toBe(409);
      expect(ai.body.error).toBe("premium_ai_unavailable");

      // Already on the tier asked for.
      await prisma.shop.update({ where: { id: shopId }, data: { plan: "pro" } });
      const same = await request(app)
        .post("/api/billing/upgrade")
        .set("Cookie", cookie)
        .send({ tier: "pro" });
      expect(same.status).toBe(409);
      expect(same.body.error).toBe("already_entitled");

      // A Premium AI shop asking for Premium is a DOWNGRADE: the portal's job.
      await prisma.shop.update({ where: { id: shopId }, data: { plan: "pro_ai" } });
      const down = await request(app)
        .post("/api/billing/upgrade")
        .set("Cookie", cookie)
        .send({ tier: "pro" });
      expect(down.status).toBe(409);
      expect(down.body.error).toBe("not_an_upgrade");

      await prisma.shop.update({ where: { id: shopId }, data: { plan: "starter" } });
    });
  });

  it("a Starter shop still inside its signup trial keeps full Premium until the trial ends", async () => {
    await prisma.shop.update({
      where: { id: shopId },
      data: { trialEndsAt: new Date(Date.now() + 3 * DAY) },
    });
    const res = await request(app).get("/api/billing").set("Cookie", cookie);
    expect(res.body.plan).toBe("starter");
    expect(res.body.entitlements.premium).toBe(true);
    expect(res.body.entitlements.insights).toBe("full");
    const insights = await request(app).get("/api/insights?period=30d").set("Cookie", cookie);
    expect(insights.body.scope).toBe("full");
  });

  it("cancellation drops starter back to free like every other tier", async () => {
    await applyStripeEvent({
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: SUB_ID,
          status: "canceled",
          customer: CUSTOMER_ID,
          metadata: { shopId, tier: "starter" },
        },
      },
    } as never);
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    expect(shop!.plan).toBe("free");
    expect(shop!.subscriptionStatus).toBe("canceled");
  });
});
