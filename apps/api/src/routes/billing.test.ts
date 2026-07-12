import request from "supertest";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import {
  BILLING,
  PLANS,
  __resetEnvCacheForTests,
  randomToken,
} from "@chairback/config";
import {
  applyStripeEvent,
  hasActiveAccess,
  trialDaysLeft,
} from "../billing/stripe.js";

/**
 * Billing: pure access logic, Stripe event folding, the HTTP surface, and the
 * 402 gate on outbound SMS. The file sets STRIPE_* env vars BEFORE importing
 * the app (dynamic import in beforeAll) so billing is ENABLED for every HTTP
 * test here; other test files run with it disabled, which is the
 * everything-stays-free mode asserted in the unit tests below.
 */
const WEBHOOK_SECRET = "whsec_test_secret";
// Lowercased: signup normalizes email, randomToken can emit uppercase.
const email = `bill-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";

let app: import("express").Express;
let cookie: string;
let shopId: string;

const DAY = 86_400_000;
// Unique per run so the test is never coupled to leftover DB rows (the
// stripeCustomerId unique index would otherwise 500 on a stale row).
const CUSTOMER_ID = `cus_test_${randomToken(8)}`;
const SUB_ID = `sub_test_${randomToken(8)}`;

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_PRICE_ID = "price_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Billing Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Billing Cuts", bookingUrl: "https://billing.test", smsAttested: true });
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

function signedPayload(event: Record<string, unknown>): {
  payload: string;
  header: string;
} {
  const payload = JSON.stringify(event);
  const header = new Stripe("sk_test_dummy").webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });
  return { payload, header };
}

describe("hasActiveAccess (pure)", () => {
  const base = { subscriptionStatus: "none", trialEndsAt: null as Date | null };

  it("always passes while billing is disabled", () => {
    expect(hasActiveAccess(base, { enabled: false })).toBe(true);
  });

  it("passes on an unexpired trial, fails once it lapses", () => {
    const now = new Date("2026-06-12T12:00:00Z");
    const inTrial = { ...base, trialEndsAt: new Date(now.getTime() + DAY) };
    const lapsed = { ...base, trialEndsAt: new Date(now.getTime() - DAY) };
    expect(hasActiveAccess(inTrial, { enabled: true, now })).toBe(true);
    expect(hasActiveAccess(lapsed, { enabled: true, now })).toBe(false);
  });

  it("active/trialing/past_due subscriptions pass; canceled does not", () => {
    for (const status of ["active", "trialing", "past_due"]) {
      expect(
        hasActiveAccess({ ...base, subscriptionStatus: status }, { enabled: true }),
      ).toBe(true);
    }
    expect(
      hasActiveAccess({ ...base, subscriptionStatus: "canceled" }, { enabled: true }),
    ).toBe(false);
  });

  it("counts trial days left (ceil, floored at 0)", () => {
    const now = new Date("2026-06-12T12:00:00Z");
    expect(
      trialDaysLeft({ ...base, trialEndsAt: new Date(now.getTime() + 1.5 * DAY) }, now),
    ).toBe(2);
    expect(
      trialDaysLeft({ ...base, trialEndsAt: new Date(now.getTime() - DAY) }, now),
    ).toBe(0);
    expect(trialDaysLeft(base, now)).toBeNull();
  });
});

describe("billing HTTP surface", () => {
  it("reports a fresh full-length trial on a new shop", async () => {
    const res = await request(app).get("/api/billing").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.billingEnabled).toBe(true);
    expect(res.body.hasAccess).toBe(true);
    expect(res.body.subscribed).toBe(false);
    // Derive from config so this never breaks when BILLING.trialDays changes.
    // A brand-new shop's trial is BILLING.trialDays out; allow 1 day of slack
    // for the ceil() in trialDaysLeft + any clock skew between create and read.
    expect(res.body.trialDaysLeft).toBeGreaterThanOrEqual(BILLING.trialDays - 1);
    expect(res.body.trialDaysLeft).toBeLessThanOrEqual(BILLING.trialDays);
  });

  it("requires auth", async () => {
    const res = await request(app).get("/api/billing");
    expect(res.status).toBe(401);
  });
});

describe("stripe webhook + event folding", () => {
  it("rejects an unsigned webhook", async () => {
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "noop" }));
    expect(res.status).toBe(400);
  });

  it("rejects a bad signature", async () => {
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=deadbeef")
      .send(JSON.stringify({ type: "noop" }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_signature");
  });

  it("checkout.session.completed activates the shop", async () => {
    const { payload, header } = signedPayload({
      id: `evt_${randomToken(6)}`,
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          object: "checkout.session",
          mode: "subscription",
          client_reference_id: shopId,
          customer: CUSTOMER_ID,
          subscription: SUB_ID,
        },
      },
    });
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", header)
      .send(payload);
    expect(res.status).toBe(200);

    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    expect(shop!.subscriptionStatus).toBe("active");
    expect(shop!.stripeCustomerId).toBe(CUSTOMER_ID);
    expect(shop!.stripeSubscriptionId).toBe(SUB_ID);
    expect(shop!.plan).toBe("pro");

    const status = await request(app).get("/api/billing").set("Cookie", cookie);
    expect(status.body.subscribed).toBe(true);
    expect(status.body.hasAccess).toBe(true);
  });

  it("subscription.deleted drops the shop back to free", async () => {
    await applyStripeEvent({
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: SUB_ID,
          status: "canceled",
          customer: CUSTOMER_ID,
          metadata: { shopId },
        },
      },
    } as never);
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    expect(shop!.subscriptionStatus).toBe("canceled");
    expect(shop!.stripeSubscriptionId).toBeNull();
    expect(shop!.plan).toBe("free");
  });

  it("falls back to the customer id when metadata is missing", async () => {
    await applyStripeEvent({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: `${SUB_ID}_2`,
          status: "past_due",
          customer: CUSTOMER_ID,
          metadata: {},
        },
      },
    } as never);
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    expect(shop!.subscriptionStatus).toBe("past_due");
    expect(shop!.plan).toBe("pro"); // past_due keeps access through dunning
  });
});

describe("402 gate once the trial lapses", () => {
  it("blocks manual nudges, real sweeps, and bulk texting; keeps the rest open", async () => {
    // Kill the sub + expire the trial.
    await prisma.shop.update({
      where: { id: shopId },
      data: {
        subscriptionStatus: "canceled",
        stripeSubscriptionId: null,
        trialEndsAt: new Date(Date.now() - DAY),
      },
    });

    const client = await request(app)
      .post("/api/dashboard/clients")
      .set("Cookie", cookie)
      .send({ firstName: "Lapsed", phone: "(302) 555-0142" });
    expect(client.status).toBe(201);

    const nudge = await request(app)
      .post(`/api/dashboard/nudge/${client.body.id}`)
      .set("Cookie", cookie);
    expect(nudge.status).toBe(402);
    expect(nudge.body.error).toBe("subscription_required");

    const sweep = await request(app)
      .post("/api/dashboard/sweep")
      .set("Cookie", cookie);
    expect(sweep.status).toBe(402);

    const bulk = await request(app)
      .post("/api/dashboard/clients/bulk")
      .set("Cookie", cookie)
      .send({ action: "nudge", clientIds: [client.body.id] });
    expect(bulk.status).toBe(402);

    // Dry-run preview and non-SMS work stay open.
    const preview = await request(app)
      .post("/api/dashboard/sweep-preview")
      .set("Cookie", cookie);
    expect(preview.status).toBe(200);

    const optOut = await request(app)
      .post("/api/dashboard/clients/bulk")
      .set("Cookie", cookie)
      .send({ action: "optOut", clientIds: [client.body.id] });
    expect(optOut.status).toBe(200);

    const stats = await request(app).get("/api/dashboard/stats").set("Cookie", cookie);
    expect(stats.status).toBe(200);

    const visit = await request(app)
      .post(`/api/dashboard/clients/${client.body.id}/visits`)
      .set("Cookie", cookie)
      .send({});
    expect(visit.status).toBe(201); // earning keeps working - data accrues

    const billing = await request(app).get("/api/billing").set("Cookie", cookie);
    expect(billing.body.hasAccess).toBe(false);
    expect(billing.body.trialDaysLeft).toBe(0);
  });
});

describe("tier mapping in stripe events", () => {
  it("subscription events with metadata.tier=pro_ai set plan pro_ai", async () => {
    await applyStripeEvent({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: `${SUB_ID}_ai`,
          status: "active",
          customer: CUSTOMER_ID,
          metadata: { shopId, tier: "pro_ai" },
        },
      },
    } as never);
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    expect(shop!.plan).toBe("pro_ai");
    expect(shop!.subscriptionStatus).toBe("active");
  });

  it("LEGACY subs without metadata.tier stay plan pro (the critical default)", async () => {
    await applyStripeEvent({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: `${SUB_ID}_legacy`,
          status: "active",
          customer: CUSTOMER_ID,
          metadata: { shopId },
        },
      },
    } as never);
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    expect(shop!.plan).toBe("pro");
  });

  it("checkout.session.completed with metadata.tier=pro_ai activates as pro_ai", async () => {
    const { payload, header } = signedPayload({
      id: `evt_${randomToken(6)}`,
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          object: "checkout.session",
          mode: "subscription",
          client_reference_id: shopId,
          customer: CUSTOMER_ID,
          subscription: `${SUB_ID}_ai2`,
          metadata: { tier: "pro_ai" },
        },
      },
    });
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", header)
      .send(payload);
    expect(res.status).toBe(200);
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    expect(shop!.plan).toBe("pro_ai");
  });

  it("cancellation drops pro_ai back to free", async () => {
    await applyStripeEvent({
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: `${SUB_ID}_ai2`,
          status: "canceled",
          customer: CUSTOMER_ID,
          metadata: { shopId, tier: "pro_ai" },
        },
      },
    } as never);
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    expect(shop!.plan).toBe("free");
    expect(shop!.subscriptionStatus).toBe("canceled");
  });

  it("add-on events still touch only receptionistSubscriptionStatus", async () => {
    await applyStripeEvent({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: `${SUB_ID}_addon`,
          status: "active",
          customer: CUSTOMER_ID,
          metadata: { shopId, addon: "receptionist" },
        },
      },
    } as never);
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    expect(shop!.receptionistSubscriptionStatus).toBe("active");
    expect(shop!.plan).toBe("free"); // untouched by the add-on branch
    // Reset for the suites below.
    await prisma.shop.update({
      where: { id: shopId },
      data: { receptionistSubscriptionStatus: "none" },
    });
  });
});

describe("premium AI HTTP surface", () => {
  beforeAll(async () => {
    // Restore an ACTIVE pro subscription (earlier suites left the shop lapsed).
    await prisma.shop.update({
      where: { id: shopId },
      data: {
        subscriptionStatus: "active",
        stripeSubscriptionId: SUB_ID,
        plan: "pro",
        receptionistSubscriptionStatus: "none",
      },
    });
  });

  it("GET /api/billing reports smsUsage + premiumAi + receptionist.included", async () => {
    const res = await request(app).get("/api/billing").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.smsUsage.quota).toBe(PLANS.pro.smsMonthlyQuota);
    expect(res.body.smsUsage.used).toBeTypeOf("number");
    expect(new Date(res.body.smsUsage.resetsAt).getTime()).toBeGreaterThan(Date.now());
    // STRIPE_PREMIUM_AI_PRICE_ID is unset here -> the tier is dark.
    expect(res.body.premiumAi.billingEnabled).toBe(false);
    expect(res.body.premiumAi.priceMonthlyUsd).toBe(PLANS.pro_ai.priceMonthlyUsd);
    expect(res.body.receptionist.included).toBe(false);
  });

  it("pro_ai checkout and upgrade 409 while the tier price is unset", async () => {
    const checkout = await request(app)
      .post("/api/billing/checkout")
      .set("Cookie", cookie)
      .send({ tier: "pro_ai" });
    expect(checkout.status).toBe(409);
    expect(checkout.body.error).toBe("premium_ai_unavailable");

    const upgrade = await request(app)
      .post("/api/billing/upgrade")
      .set("Cookie", cookie);
    expect(upgrade.status).toBe(409);
    expect(upgrade.body.error).toBe("premium_ai_unavailable");
  });

  describe("with the tier price configured", () => {
    beforeAll(() => {
      process.env.STRIPE_PREMIUM_AI_PRICE_ID = "price_test_premium_ai";
      process.env.STRIPE_RECEPTIONIST_PRICE_ID = "price_test_receptionist";
      __resetEnvCacheForTests();
    });
    afterAll(() => {
      delete process.env.STRIPE_PREMIUM_AI_PRICE_ID;
      delete process.env.STRIPE_RECEPTIONIST_PRICE_ID;
      __resetEnvCacheForTests();
    });

    it("upgrade 409s already_entitled on a pro_ai shop", async () => {
      await prisma.shop.update({ where: { id: shopId }, data: { plan: "pro_ai" } });
      const res = await request(app)
        .post("/api/billing/upgrade")
        .set("Cookie", cookie);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("already_entitled");
    });

    it("the add-on checkout 409s already_entitled on a pro_ai shop", async () => {
      const res = await request(app)
        .post("/api/billing/receptionist/checkout")
        .set("Cookie", cookie);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("already_entitled");
    });

    it("upgrade 409s already_entitled when the $40 add-on is active", async () => {
      await prisma.shop.update({
        where: { id: shopId },
        data: { plan: "pro", receptionistSubscriptionStatus: "active" },
      });
      const res = await request(app)
        .post("/api/billing/upgrade")
        .set("Cookie", cookie);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("already_entitled");
      await prisma.shop.update({
        where: { id: shopId },
        data: { receptionistSubscriptionStatus: "none" },
      });
    });

    it("upgrade 409s no_subscription for a trial/free shop", async () => {
      await prisma.shop.update({
        where: { id: shopId },
        data: {
          plan: "free",
          subscriptionStatus: "canceled",
          stripeSubscriptionId: null,
        },
      });
      const res = await request(app)
        .post("/api/billing/upgrade")
        .set("Cookie", cookie);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("no_subscription");
      // Restore the active pro sub for the quota suite below.
      await prisma.shop.update({
        where: { id: shopId },
        data: { plan: "pro", subscriptionStatus: "active", stripeSubscriptionId: SUB_ID },
      });
    });
  });
});

describe("monthly SMS quota hard stop", () => {
  it("402s the manual nudge once the month's quota is spent", async () => {
    // A timezone whose local hour is ~midday right now, so the quiet-hours
    // gate (which runs before the quota check) never trips regardless of when
    // the suite runs. Etc/GMT+X = UTC-X (sign inverted by IANA convention).
    const utcHour = new Date().getUTCHours();
    let offset = utcHour - 12; // local = utc - offset = ~12
    if (offset < -12) offset += 24;
    if (offset > 12) offset -= 24;
    const middayTz =
      offset === 0 ? "Etc/GMT" : offset > 0 ? `Etc/GMT+${offset}` : `Etc/GMT-${-offset}`;
    await prisma.shop.update({
      where: { id: shopId },
      data: { timezone: middayTz, dailySendCap: 1000 },
    });

    const client = await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: `quota-http-${randomToken(6)}`,
        magicToken: randomToken(),
        firstName: "Q",
        phone: "+13025550188",
        smsConsentAt: new Date(),
        smsConsentSource: "barber_attest",
      },
    });

    // Spend the whole monthly quota with SENT marketing rows from this month.
    await prisma.nudge.createMany({
      data: Array.from({ length: PLANS.pro.smsMonthlyQuota }, () => ({
        shopId,
        clientId: client.id,
        channel: "SMS" as const,
        status: "SENT" as const,
        kind: "nudge",
      })),
    });

    const res = await request(app)
      .post(`/api/dashboard/nudge/${client.id}`)
      .set("Cookie", cookie);
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("sms_quota_exhausted");
  });
});
