import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import type { Express } from "express";

/**
 * ENTITLEMENTS FOLLOW VERIFIED STATE, NOT A REDIRECT.
 *
 *   - a subscription that is incomplete, unpaid, canceled or paused grants
 *     nothing once the trial has lapsed; past_due rides Stripe's dunning
 *     window by documented policy; a comp ignores Stripe entirely
 *   - `?checkout=success` on the billing page is a query string the browser
 *     brings back from Stripe. The API never reads it: access is computed
 *     from the Shop row the webhook wrote, and nothing else
 *   - a walled route answers 402 to a lapsed shop whatever the URL says
 */

const email = `entitle-${randomToken(6)}@test.local`;
const password = "supersecret123";
let app: Express;
let cookie: string;
let shopId: string;

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_PRICE_ID = "price_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_entitle";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_entitle_connect";
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Entitle", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Entitle Cuts", bookingUrl: "https://entitle.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

const { hasActiveAccess } = await import("./stripe.js");
const DAY = 86_400_000;
// The real clock: the route under test reads Date.now(), so "lapsed" has to
// be lapsed for it too, not just for the pure function handed a fixed now.
const now = new Date();
const lapsed = new Date(now.getTime() - DAY);

async function setShop(data: Record<string, unknown>) {
  await prisma.shop.update({ where: { id: shopId }, data });
}

describe("hasActiveAccess (verified Stripe state only)", () => {
  it.each([
    ["incomplete", false],
    ["incomplete_expired", false],
    ["unpaid", false],
    ["canceled", false],
    ["paused", false],
    ["none", false],
    ["past_due", true],
    ["active", true],
    ["trialing", true],
  ])("subscriptionStatus %s with a lapsed trial -> access %s", (status, expected) => {
    expect(
      hasActiveAccess({ subscriptionStatus: status, trialEndsAt: lapsed }, { enabled: true, now }),
    ).toBe(expected);
  });

  it("a comp ignores Stripe entirely; a live trial passes on its own", () => {
    expect(
      hasActiveAccess({ subscriptionStatus: "unpaid", trialEndsAt: lapsed, compAccess: true }, { enabled: true, now }),
    ).toBe(true);
    expect(
      hasActiveAccess(
        { subscriptionStatus: "none", trialEndsAt: new Date(now.getTime() + DAY) },
        { enabled: true, now },
      ),
    ).toBe(true);
  });
});

describe("a browser success redirect grants nothing", () => {
  it("GET /api/billing reports no access for an incomplete subscription, whatever the query string says", async () => {
    await setShop({ subscriptionStatus: "incomplete", trialEndsAt: lapsed, stripeSubscriptionId: "sub_incomplete" });
    for (const qs of ["", "?checkout=success", "?upgrade=success&receptionist=success"]) {
      const res = await request(app).get(`/api/billing${qs}`).set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body.hasAccess).toBe(false);
      expect(res.body.subscribed).toBe(false);
    }
  });

  it("a walled route answers 402 to a lapsed shop; the same shop passes once the webhook wrote 'active'", async () => {
    await setShop({ subscriptionStatus: "unpaid", trialEndsAt: lapsed });
    const walled = await request(app)
      .patch("/api/payments/settings?checkout=success")
      .set("Cookie", cookie)
      .send({ cancelWindowHours: 24 });
    expect(walled.status).toBe(402);
    expect(walled.body.error).toBe("subscription_required");

    await setShop({ subscriptionStatus: "active" });
    const open = await request(app)
      .patch("/api/payments/settings")
      .set("Cookie", cookie)
      .send({ cancelWindowHours: 24 });
    expect(open.status).not.toBe(402);
  });
});
