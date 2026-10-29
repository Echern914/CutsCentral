import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { PLANS, __resetEnvCacheForTests, randomToken } from "@chairback/config";

/**
 * What a shop PAID for is what it gets - checked on the server, with billing
 * ENABLED (dummy STRIPE_* set before the app is imported, so every gate is
 * real). Each block here is a leak the 2026-10-28 tier audit found open:
 *
 *   - Starter could send a one-off rebooking nudge and run the batch sweep;
 *   - the receptionist add-on could be bought on Starter (and on a trial or a
 *     lapsed shop), and Starter + add-on - or an AI trial a shop downgraded
 *     under - ran the receptionist and got Premium AI's 20,000 emails;
 *   - a plain Premium shop could reply from the AI inbox;
 *   - a downgrade in the Stripe Customer Portal kept the OLD tier, because the
 *     plan was read from metadata the portal never rewrites;
 *   - every lapse was called a "trial", even a comp that was switched off.
 *
 * Plus: a shop that was comped (no Stripe customer, trial long gone) can buy
 * any of the three plans straight from checkout. Stripe itself is stubbed -
 * nothing here leaves the process.
 */

const stripeCalls = vi.hoisted(() => ({
  customers: [] as Record<string, unknown>[],
  sessions: [] as Record<string, unknown>[],
}));
vi.mock("stripe", () => {
  class FakeStripe {
    customers = {
      create: async (params: Record<string, unknown>) => {
        stripeCalls.customers.push(params);
        return { id: `cus_plan_${stripeCalls.customers.length}_${Date.now()}` };
      },
    };
    checkout = {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          stripeCalls.sessions.push(params);
          return { id: "cs_test_plan", url: "https://checkout.test/session" };
        },
      },
    };
  }
  return { default: FakeStripe, Stripe: FakeStripe };
});

const email = `plangate-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
const DAY = 86_400_000;
const STARTER_PRICE = "price_plan_starter";
const PREMIUM_PRICE = "price_plan_premium";
const AI_PRICE = "price_plan_ai";

let app: import("express").Express;
let cookie: string;
let shopId: string;

/** Put the shop in a known billing state; everything else back to neutral. */
async function setShop(data: Record<string, unknown>) {
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      plan: "free",
      subscriptionStatus: "none",
      stripeSubscriptionId: null,
      stripeCustomerId: null,
      subscriptionEventCreated: null,
      trialEndsAt: new Date(Date.now() - 30 * DAY),
      compAccess: false,
      compEndedAt: null,
      receptionistCompAccess: false,
      receptionistSubscriptionStatus: "none",
      aiTrialEndsAt: null,
      ...data,
    },
  });
}

const PAID = (plan: string) => ({
  plan,
  subscriptionStatus: "active",
  stripeSubscriptionId: `sub_plan_${randomToken(8)}`,
});

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_PRICE_ID = PREMIUM_PRICE;
  process.env.STRIPE_STARTER_PRICE_ID = STARTER_PRICE;
  process.env.STRIPE_PREMIUM_AI_PRICE_ID = AI_PRICE;
  process.env.STRIPE_RECEPTIONIST_PRICE_ID = "price_plan_addon";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_plan";
  // The receptionist verdict is only reachable with a key and texting on.
  // Never called: nothing here runs a receptionist turn.
  process.env.ANTHROPIC_API_KEY ||= "test-key-never-used";
  process.env.SMS_ENABLED = "true";
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Plan Tester", smsAttested: true, acceptTerms: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Plan Cuts", bookingUrl: "https://plan.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "native" } });
});

afterAll(async () => {
  for (const k of [
    "STRIPE_SECRET_KEY",
    "STRIPE_PRICE_ID",
    "STRIPE_STARTER_PRICE_ID",
    "STRIPE_PREMIUM_AI_PRICE_ID",
    "STRIPE_RECEPTIONIST_PRICE_ID",
    "STRIPE_WEBHOOK_SECRET",
  ]) {
    delete process.env[k];
  }
  __resetEnvCacheForTests();
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

const post = (path: string, body: Record<string, unknown> = {}) =>
  request(app).post(path).set("Cookie", cookie).send(body);

describe("Starter is refused the Premium sends", () => {
  beforeEach(() => setShop(PAID("starter")));

  it("a one-off rebooking nudge is Premium", async () => {
    const res = await post("/api/dashboard/nudge/no-such-client");
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("premium_required");
  });

  it("the batch sweep is Premium", async () => {
    const res = await post("/api/dashboard/sweep");
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("premium_required");
  });

  it("Premium gets past the same gates (the gate is the plan, not the route)", async () => {
    await setShop(PAID("pro"));
    const nudge = await post("/api/dashboard/nudge/no-such-client");
    expect(nudge.status).toBe(404);
  });
});

describe("the receptionist add-on goes on top of a paid Premium plan only", () => {
  it.each([
    ["Starter", () => PAID("starter")],
    ["a signup trial", () => ({ trialEndsAt: new Date(Date.now() + 5 * DAY) })],
    ["a lapsed shop", () => ({ plan: "pro", subscriptionStatus: "canceled" })],
  ])("%s cannot buy it", async (_label, state) => {
    await setShop(state());
    const res = await post("/api/billing/receptionist/checkout");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("premium_required");
  });

  it("a paying Premium shop can", async () => {
    await setShop({ ...PAID("pro"), stripeCustomerId: `cus_plan_addon_${randomToken(6)}` });
    const res = await post("/api/billing/receptionist/checkout");
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://checkout.test/session");
  });
});

describe("the receptionist runs only where it was paid for", () => {
  const STARTER_PLUS_ADDON = () => ({ ...PAID("starter"), receptionistSubscriptionStatus: "active" });
  const STARTER_UNDER_AI_TRIAL = () => ({
    ...PAID("starter"),
    aiTrialEndsAt: new Date(Date.now() + 5 * DAY),
  });

  it.each([
    ["Starter + the add-on", STARTER_PLUS_ADDON],
    ["Starter still inside an AI trial it downgraded under", STARTER_UNDER_AI_TRIAL],
  ])("%s: not entitled, Starter's email allowance, no inbox reply, no toggle", async (_l, state) => {
    await setShop(state());
    const billing = await request(app).get("/api/billing").set("Cookie", cookie);
    expect(billing.body.entitlements.receptionist).toBe(false);
    expect(billing.body.receptionist.entitled).toBe(false);
    expect(billing.body.emailUsage.quota).toBe(PLANS.starter.emailMonthlyQuota);

    const reply = await post("/api/dashboard/receptionist/conversations/x/reply", { body: "hi" });
    expect(reply.status).toBe(402);
    expect(reply.body.error).toBe("premium_ai_required");

    const toggle = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ receptionistEnabled: true, acceptReceptionistTerms: true });
    expect(toggle.status).toBe(409);
    expect(toggle.body.error).toBe("receptionist_not_entitled");
  });

  it("the turn-level skip reason names the plan", async () => {
    const { receptionistSkipReason, hasReceptionistPlan } = await import("../receptionist/config.js");
    const base = {
      ...PAID("starter"),
      trialEndsAt: null,
      compAccess: false,
      aiTrialEndsAt: null,
      receptionistEnabled: true,
      receptionistSubscriptionStatus: "active",
      receptionistCompAccess: false,
      receptionistTermsAcceptedAt: new Date(),
      bookingMode: "native",
    };
    expect(hasReceptionistPlan(base, { enabled: true })).toBe(false);
    expect(hasReceptionistPlan({ ...base, plan: "pro" }, { enabled: true })).toBe(true);
    // A comped receptionist pilot stands on its own.
    expect(hasReceptionistPlan({ ...base, receptionistCompAccess: true }, { enabled: true })).toBe(true);
    // The full verdict, with the AI key and texting on (beforeAll): the
    // reason must be the plan, not anything vaguer.
    expect(receptionistSkipReason(base)).toBe("premium_required");
    expect(receptionistSkipReason({ ...base, plan: "pro" })).toBeNull();
  });

  it("plain Premium cannot reply from the AI inbox; Premium + add-on can get past the gate", async () => {
    await setShop(PAID("pro"));
    const plain = await post("/api/dashboard/receptionist/conversations/x/reply", { body: "hi" });
    expect(plain.status).toBe(402);
    expect(plain.body.error).toBe("premium_ai_required");

    await setShop({ ...PAID("pro"), receptionistSubscriptionStatus: "active" });
    const withAddon = await post("/api/dashboard/receptionist/conversations/x/reply", { body: "hi" });
    expect(withAddon.status).toBe(404);
    const billing = await request(app).get("/api/billing").set("Cookie", cookie);
    expect(billing.body.emailUsage.quota).toBe(PLANS.pro_ai.emailMonthlyQuota);
  });
});

describe("the plan follows the PRICE the shop pays", () => {
  it("a Customer Portal downgrade to Starter drops the plan, though metadata still says pro", async () => {
    const sub = `sub_plan_portal_${randomToken(8)}`;
    const customer = `cus_plan_portal_${randomToken(8)}`;
    await setShop({ ...PAID("pro"), stripeSubscriptionId: sub, stripeCustomerId: customer });
    const { applyStripeEvent } = await import("../billing/stripe.js");
    await applyStripeEvent({
      type: "customer.subscription.updated",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: sub,
          status: "active",
          customer,
          metadata: { shopId, tier: "pro" },
          items: { data: [{ price: { id: STARTER_PRICE } }] },
        },
      },
    } as never);
    const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
    expect(shop!.plan).toBe("starter");
  });

  it("an upgrade in the portal raises it the same way", async () => {
    const sub = `sub_plan_up_${randomToken(8)}`;
    const customer = `cus_plan_up_${randomToken(8)}`;
    await setShop({ ...PAID("starter"), stripeSubscriptionId: sub, stripeCustomerId: customer });
    const { applyStripeEvent } = await import("../billing/stripe.js");
    await applyStripeEvent({
      type: "customer.subscription.updated",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: sub,
          status: "active",
          customer,
          metadata: { shopId, tier: "starter" },
          items: { data: [{ price: AI_PRICE }] },
        },
      },
    } as never);
    const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { plan: true } });
    expect(shop!.plan).toBe("pro_ai");
  });
});

describe("a lapse is called what it is", () => {
  it("trial ended", async () => {
    await setShop({});
    const res = await request(app).get("/api/billing").set("Cookie", cookie);
    expect(res.body.hasAccess).toBe(false);
    expect(res.body.lapse).toBe("trial_ended");
  });

  it("comp ended - not a trial, even with an old trial date on file", async () => {
    await setShop({ compEndedAt: new Date() });
    const res = await request(app).get("/api/billing").set("Cookie", cookie);
    expect(res.body.lapse).toBe("comp_ended");
  });

  it("subscription ended", async () => {
    await setShop({ plan: "free", subscriptionStatus: "canceled", stripeSubscriptionId: "sub_gone" });
    const res = await request(app).get("/api/billing").set("Cookie", cookie);
    expect(res.body.lapse).toBe("subscription_ended");
  });

  it("an active shop has no lapse", async () => {
    await setShop(PAID("pro"));
    const res = await request(app).get("/api/billing").set("Cookie", cookie);
    expect(res.body.lapse).toBeNull();
  });

  it("lapseReasonFor: a subscription that started AFTER the comp ended reads as the subscription", async () => {
    const { lapseReasonFor } = await import("../billing/entitlements.js");
    const now = new Date("2026-06-01T00:00:00Z");
    const shop = {
      subscriptionStatus: "canceled",
      trialEndsAt: new Date("2026-01-01T00:00:00Z"),
      compAccess: false,
      compEndedAt: new Date("2026-02-01T00:00:00Z"),
      subscriptionEventCreated: Math.floor(new Date("2026-03-01T00:00:00Z").getTime() / 1000),
    };
    expect(lapseReasonFor(shop, { now, enabled: true })).toBe("subscription_ended");
    expect(lapseReasonFor({ ...shop, subscriptionEventCreated: null }, { now, enabled: true })).toBe(
      "comp_ended",
    );
    expect(
      lapseReasonFor(
        { ...shop, subscriptionStatus: "incomplete", compEndedAt: null, subscriptionEventCreated: null },
        { now, enabled: true },
      ),
    ).toBe("trial_ended");
    expect(
      lapseReasonFor(
        { ...shop, subscriptionStatus: "none", compEndedAt: null, trialEndsAt: null },
        { now, enabled: true },
      ),
    ).toBe("no_plan");
    expect(lapseReasonFor({ ...shop, compAccess: true }, { now, enabled: true })).toBeNull();
  });
});

describe("a shop whose comp was removed can buy any plan straight away", () => {
  it.each([
    ["starter", STARTER_PRICE],
    ["pro", PREMIUM_PRICE],
    ["pro_ai", AI_PRICE],
  ])("%s: checkout creates the Stripe customer and bills now (no second trial)", async (tier, price) => {
    // Comped shops never went through checkout: no customer, no subscription,
    // and the signup trial is long over.
    await setShop({ compEndedAt: new Date() });
    stripeCalls.customers.length = 0;
    stripeCalls.sessions.length = 0;

    const res = await post("/api/billing/checkout", { tier });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://checkout.test/session");

    expect(stripeCalls.customers).toHaveLength(1);
    expect(stripeCalls.sessions).toHaveLength(1);
    const session = stripeCalls.sessions[0] as {
      line_items: { price: string }[];
      subscription_data: { metadata: { tier: string }; trial_end?: number };
    };
    expect(session.line_items[0]!.price).toBe(price);
    expect(session.subscription_data.metadata.tier).toBe(tier);
    expect(session.subscription_data.trial_end).toBeUndefined();

    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { stripeCustomerId: true },
    });
    expect(shop!.stripeCustomerId).toMatch(/^cus_plan_/);
  });
});
