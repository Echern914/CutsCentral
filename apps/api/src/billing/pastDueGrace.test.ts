import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import type { Express } from "express";

/**
 * TWO DAYS, THEN LOCKED - and an upgrade only happens if it is paid for.
 *
 *   - a declined subscription charge (past_due) keeps the shop working for
 *     exactly PAST_DUE_GRACE_MS from the decline, then locks it until paid;
 *   - the webhook stamps the decline ONCE per episode: a replayed or later
 *     past_due event never restarts the clock, and paying clears it;
 *   - an upgrade whose prorated charge is declined changes nothing (Stripe's
 *     pending update) and tells the barber; one that is paid switches plan;
 *   - a shop that already owes money cannot stack an upgrade charge on top.
 */

const email = `pastdue-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
const CUSTOMER_ID = `cus_pastdue_${randomToken(8)}`;
const SUB_ID = `sub_pastdue_${randomToken(8)}`;
let app: Express;
let cookie: string;
let shopId: string;

const stripeMod = await import("./stripe.js");
const { hasActiveAccess, pastDueLocksAt, PAST_DUE_GRACE_MS, applyStripeEvent } = stripeMod;
const { lapseReasonFor } = await import("./entitlements.js");

const DAY = 86_400_000;

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_PRICE_ID = "price_test_pro";
  process.env.STRIPE_STARTER_PRICE_ID = "price_test_starter";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_pastdue";
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Past Due", smsAttested: true, acceptTerms: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Past Due Cuts", bookingUrl: "https://pastdue.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
});

afterEach(() => {
  stripeMod.__setStripeClientForTests(null);
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  delete process.env.STRIPE_STARTER_PRICE_ID;
  __resetEnvCacheForTests();
  await prisma.$disconnect();
});

async function setShop(data: Record<string, unknown>) {
  await prisma.shop.update({ where: { id: shopId }, data });
}

const reload = () => prisma.shop.findUniqueOrThrow({ where: { id: shopId } });

describe("hasActiveAccess: a declined charge gets two days", () => {
  const declinedAt = new Date("2026-11-17T09:27:00Z");
  const pastDue = {
    subscriptionStatus: "past_due",
    trialEndsAt: null,
    pastDueSince: declinedAt,
  };
  const at = (ms: number) => new Date(declinedAt.getTime() + ms);
  const ON = (now: Date) => ({ enabled: true, now });

  it("is two days, not Stripe's whole retry schedule", () => {
    expect(PAST_DUE_GRACE_MS).toBe(2 * DAY);
  });

  it("works right after the decline and up to the last millisecond of day two", () => {
    expect(hasActiveAccess(pastDue, ON(at(0)))).toBe(true);
    expect(hasActiveAccess(pastDue, ON(at(DAY)))).toBe(true);
    expect(hasActiveAccess(pastDue, ON(at(2 * DAY - 1)))).toBe(true);
  });

  it("locks at exactly two days, and stays locked", () => {
    expect(hasActiveAccess(pastDue, ON(at(2 * DAY)))).toBe(false);
    expect(hasActiveAccess(pastDue, ON(at(10 * DAY)))).toBe(false);
  });

  it("an unstamped past_due keeps access: a lock needs a recorded decline", () => {
    expect(hasActiveAccess({ ...pastDue, pastDueSince: null }, ON(at(30 * DAY)))).toBe(true);
  });

  it("a comp and billing-off both ignore it", () => {
    expect(hasActiveAccess({ ...pastDue, compAccess: true }, ON(at(10 * DAY)))).toBe(true);
    expect(hasActiveAccess(pastDue, { enabled: false, now: at(10 * DAY) })).toBe(true);
  });

  it("a stale stamp on a shop that is active again locks nothing", () => {
    expect(
      hasActiveAccess({ ...pastDue, subscriptionStatus: "active" }, ON(at(10 * DAY))),
    ).toBe(true);
  });

  it("pastDueLocksAt is the decline plus two days, null when not past due", () => {
    expect(pastDueLocksAt(pastDue)?.toISOString()).toBe(at(2 * DAY).toISOString());
    expect(pastDueLocksAt({ ...pastDue, subscriptionStatus: "active" })).toBeNull();
    expect(pastDueLocksAt({ ...pastDue, pastDueSince: null })).toBeNull();
  });

  it("a locked past_due or unpaid shop reads as payment_failed, never 'plan ended'", () => {
    const lapse = { ...pastDue, compAccess: false, compEndedAt: null, subscriptionEventCreated: null };
    expect(lapseReasonFor(lapse, ON(at(DAY)))).toBeNull();
    expect(lapseReasonFor(lapse, ON(at(3 * DAY)))).toBe("payment_failed");
    expect(
      lapseReasonFor({ ...lapse, subscriptionStatus: "unpaid", pastDueSince: null }, ON(at(3 * DAY))),
    ).toBe("payment_failed");
  });
});

describe("the webhook stamps the decline once per episode", () => {
  const event = (status: string, created: number) =>
    ({
      type: "customer.subscription.updated",
      created,
      data: {
        object: {
          id: SUB_ID,
          status,
          customer: CUSTOMER_ID,
          metadata: { shopId, tier: "pro" },
        },
      },
    }) as never;

  it("stamps at the event's time, keeps the first stamp on a later past_due, clears on payment", async () => {
    await setShop({
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUB_ID,
      subscriptionStatus: "active",
      subscriptionEventCreated: null,
      pastDueSince: null,
      plan: "pro",
    });
    const t0 = Math.floor(Date.now() / 1000) - 3600;

    await applyStripeEvent(event("past_due", t0));
    let shop = await reload();
    expect(shop.subscriptionStatus).toBe("past_due");
    expect(shop.pastDueSince?.getTime()).toBe(t0 * 1000);

    // A later past_due (another retry failed) does NOT restart the two days.
    await applyStripeEvent(event("past_due", t0 + 600));
    shop = await reload();
    expect(shop.pastDueSince?.getTime()).toBe(t0 * 1000);

    // Paid: back to active, the stamp is gone.
    await applyStripeEvent(event("active", t0 + 1200));
    shop = await reload();
    expect(shop.subscriptionStatus).toBe("active");
    expect(shop.pastDueSince).toBeNull();

    // A NEW decline is a new episode with its own two days.
    await applyStripeEvent(event("past_due", t0 + 1800));
    shop = await reload();
    expect(shop.pastDueSince?.getTime()).toBe((t0 + 1800) * 1000);
  });

  it("a stale past_due arriving after the payment changes nothing", async () => {
    await setShop({
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUB_ID,
      subscriptionStatus: "active",
      subscriptionEventCreated: null,
      pastDueSince: null,
    });
    const t0 = Math.floor(Date.now() / 1000) - 3600;
    await applyStripeEvent(event("active", t0 + 100));
    await applyStripeEvent(event("past_due", t0)); // older: out of order
    const shop = await reload();
    expect(shop.subscriptionStatus).toBe("active");
    expect(shop.pastDueSince).toBeNull();
  });
});

describe("GET /api/billing and the wall follow the two days", () => {
  it("inside the grace: access, with the lock time; past it: 402 and payment_failed", async () => {
    const since = new Date(Date.now() - DAY);
    await setShop({
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUB_ID,
      subscriptionStatus: "past_due",
      pastDueSince: since,
      trialEndsAt: new Date(Date.now() - 30 * DAY),
      compAccess: false,
    });
    let res = await request(app).get("/api/billing").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.hasAccess).toBe(true);
    expect(res.body.subscribed).toBe(true);
    expect(res.body.lapse).toBeNull();
    expect(res.body.pastDueLocksAt).toBe(new Date(since.getTime() + 2 * DAY).toISOString());

    await setShop({ pastDueSince: new Date(Date.now() - 3 * DAY) });
    res = await request(app).get("/api/billing").set("Cookie", cookie);
    expect(res.body.hasAccess).toBe(false);
    expect(res.body.lapse).toBe("payment_failed");
    const walled = await request(app)
      .patch("/api/payments/settings")
      .set("Cookie", cookie)
      .send({ cancelWindowHours: 24 });
    expect(walled.status).toBe(402);
  });
});

describe("an upgrade only happens if its charge goes through", () => {
  type Call = { id: string; params: Record<string, unknown>; opts?: Record<string, unknown> };

  function fakeStripe(answer: { pending: boolean }) {
    const calls: Call[] = [];
    const fake = {
      subscriptions: {
        retrieve: async (id: string) => ({
          id,
          metadata: { shopId, tier: "starter" },
          items: { data: [{ id: "si_test_1" }] },
        }),
        update: async (id: string, params: Record<string, unknown>, opts?: Record<string, unknown>) => {
          calls.push({ id, params, opts });
          const isPriceSwap = Array.isArray(params.items);
          return {
            id,
            pending_update: isPriceSwap && answer.pending ? { expires_at: 0 } : null,
          };
        },
      },
    };
    stripeMod.__setStripeClientForTests(fake);
    return calls;
  }

  async function starterShop() {
    await setShop({
      plan: "starter",
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUB_ID,
      subscriptionStatus: "active",
      pastDueSince: null,
      compAccess: false,
    });
  }

  it("declined: 402 card_declined, plan unchanged, nothing tagged", async () => {
    await starterShop();
    const calls = fakeStripe({ pending: true });
    const res = await request(app)
      .post("/api/billing/upgrade")
      .set("Cookie", cookie)
      .send({ tier: "pro" });
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("card_declined");
    expect((await reload()).plan).toBe("starter");
    // One call: the price swap, asked as a PENDING update. No metadata call.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params.payment_behavior).toBe("pending_if_incomplete");
    expect(calls[0]!.params.proration_behavior).toBe("always_invoice");
    expect(calls[0]!.params.metadata).toBeUndefined();
  });

  it("paid: 200, plan switched, then tagged in a separate call", async () => {
    await starterShop();
    const calls = fakeStripe({ pending: false });
    const res = await request(app)
      .post("/api/billing/upgrade")
      .set("Cookie", cookie)
      .send({ tier: "pro" });
    expect(res.status).toBe(200);
    expect((await reload()).plan).toBe("pro");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.params.payment_behavior).toBe("pending_if_incomplete");
    expect(calls[1]!.params).toEqual({ metadata: { shopId, tier: "pro" } });
  });

  it("a shop that already owes money is told to pay first, and Stripe is never called", async () => {
    await starterShop();
    await setShop({ subscriptionStatus: "past_due", pastDueSince: new Date() });
    const calls = fakeStripe({ pending: false });
    const res = await request(app)
      .post("/api/billing/upgrade")
      .set("Cookie", cookie)
      .send({ tier: "pro" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("payment_past_due");
    expect(calls).toHaveLength(0);
    expect((await reload()).plan).toBe("starter");
  });
});

describe("Update payment opens the unpaid bill itself", () => {
  it("past_due with an open invoice -> its hosted page; otherwise the portal", async () => {
    await setShop({
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUB_ID,
      subscriptionStatus: "past_due",
      pastDueSince: new Date(),
    });
    let invoiceStatus = "open";
    stripeMod.__setStripeClientForTests({
      subscriptions: {
        retrieve: async () => ({
          latest_invoice: { status: invoiceStatus, hosted_invoice_url: "https://invoice.test/pay" },
        }),
      },
      billingPortal: {
        sessions: { create: async () => ({ url: "https://portal.test/session" }) },
      },
    });
    let res = await request(app)
      .post("/api/billing/portal")
      .set("Cookie", cookie)
      .send({ flow: "pay" });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://invoice.test/pay");

    invoiceStatus = "paid";
    res = await request(app).post("/api/billing/portal").set("Cookie", cookie).send({ flow: "pay" });
    expect(res.body.url).toBe("https://portal.test/session");

    // Without flow=pay it is the portal as before, even while past due.
    invoiceStatus = "open";
    res = await request(app).post("/api/billing/portal").set("Cookie", cookie).send({});
    expect(res.body.url).toBe("https://portal.test/session");
  });
});
