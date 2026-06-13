import request from "supertest";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
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
    .send({ email, password, name: "Billing Tester" });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Billing Cuts", bookingUrl: "https://billing.test" });
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
  it("reports a fresh ~14-day trial on a new shop", async () => {
    const res = await request(app).get("/api/billing").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.billingEnabled).toBe(true);
    expect(res.body.hasAccess).toBe(true);
    expect(res.body.subscribed).toBe(false);
    expect(res.body.trialDaysLeft).toBeGreaterThanOrEqual(13);
    expect(res.body.trialDaysLeft).toBeLessThanOrEqual(14);
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
