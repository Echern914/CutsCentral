import request from "supertest";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import type { Express } from "express";

/**
 * THE WEBHOOK WALLS, end to end through the real routes with really signed
 * bodies. Each test here is a falsifier: delete the wall it names and it
 * fails.
 *
 *   - an invalid signature leaves NO trace - no receipt row, no shop change
 *   - a test-mode event never reaches a handler under a live key (and vice
 *     versa); refused with no receipt row
 *   - the same event id delivered three times is applied once and answered
 *     `duplicate` twice
 *   - an OLDER subscription event arriving after a NEWER one cannot move the
 *     shop backwards - a replayed "active" after "canceled" is refused
 *   - one event id delivered to BOTH endpoints is applied once
 *   - a handler that throws settles the receipt as `failed` and answers 500,
 *     so Stripe redelivers; the redelivery is re-applied, not refused
 */

const WEBHOOK_SECRET = "whsec_integrity_" + randomToken(6);
const CONNECT_SECRET = "whsec_connect_" + randomToken(6);
const email = `integrity-${randomToken(6)}@test.local`;
const password = "supersecret123";

let app: Express;
let shopId: string;
const eventIds: string[] = [];
const CUSTOMER_ID = `cus_int_${randomToken(8)}`;
const SUB_ID = `sub_int_${randomToken(8)}`;

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_PRICE_ID = "price_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Integrity Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Integrity Cuts", bookingUrl: "https://integrity.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  await prisma.shop.update({ where: { id: shopId }, data: { stripeCustomerId: CUSTOMER_ID } });
});

afterAll(async () => {
  await prisma.stripeEventReceipt.deleteMany({ where: { eventId: { in: eventIds } } });
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

function evtId(): string {
  const id = `evt_int_${randomToken(8)}`;
  eventIds.push(id);
  return id;
}

function sign(event: Record<string, unknown>, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const header = new Stripe("sk_test_dummy").webhooks.generateTestHeaderString({ payload, secret });
  return { payload, header };
}

function subscriptionEvent(opts: {
  id?: string;
  type: "customer.subscription.updated" | "customer.subscription.deleted" | "customer.subscription.created";
  status: string;
  created: number;
  livemode?: boolean;
}) {
  return {
    id: opts.id ?? evtId(),
    object: "event",
    type: opts.type,
    livemode: opts.livemode ?? false,
    created: opts.created,
    data: {
      object: {
        object: "subscription",
        id: SUB_ID,
        customer: CUSTOMER_ID,
        status: opts.status,
        metadata: { shopId },
      },
    },
  };
}

async function post(path: string, body: { payload: string; header: string }) {
  return request(app)
    .post(path)
    .set("Content-Type", "application/json")
    .set("stripe-signature", body.header)
    .send(body.payload);
}

const shop = () =>
  prisma.shop.findUnique({
    where: { id: shopId },
    select: { subscriptionStatus: true, subscriptionEventCreated: true, plan: true },
  });

const T = 1_800_000_000;

describe("webhook walls", () => {
  it("an invalid signature causes no database mutation - no receipt, no state", async () => {
    const before = await shop();
    const id = evtId();
    const forged = subscriptionEvent({ id, type: "customer.subscription.updated", status: "active", created: T });
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=deadbeef")
      .send(JSON.stringify(forged));
    expect(res.status).toBe(400);
    expect(await prisma.stripeEventReceipt.findUnique({ where: { eventId: id } })).toBeNull();
    expect(await shop()).toEqual(before);
  });

  it("a live-mode event is refused by a test-mode process, and leaves no receipt", async () => {
    const before = await shop();
    const id = evtId();
    const res = await post(
      "/webhooks/stripe",
      sign(subscriptionEvent({ id, type: "customer.subscription.updated", status: "active", created: T, livemode: true })),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("livemode_mismatch");
    expect(await prisma.stripeEventReceipt.findUnique({ where: { eventId: id } })).toBeNull();
    expect(await shop()).toEqual(before);
  });

  it("replaying one event three times applies it once and says so twice", async () => {
    const id = evtId();
    const body = sign(subscriptionEvent({ id, type: "customer.subscription.updated", status: "active", created: T + 10 }));
    const first = await post("/webhooks/stripe", body);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true });
    const second = await post("/webhooks/stripe", body);
    const third = await post("/webhooks/stripe", body);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true, duplicate: true });
    expect(third.body).toEqual({ received: true, duplicate: true });
    const receipts = await prisma.stripeEventReceipt.findMany({ where: { eventId: id } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.status).toBe("processed");
    expect(receipts[0]!.attempts).toBe(1);
    const s = await shop();
    expect(s?.subscriptionStatus).toBe("active");
    expect(s?.subscriptionEventCreated).toBe(T + 10);
  });

  it("🔴 an OLDER event cannot overwrite NEWER state: a replayed 'active' after 'canceled' is refused", async () => {
    // Newest first: the subscription was deleted at T+100.
    const del = await post(
      "/webhooks/stripe",
      sign(subscriptionEvent({ type: "customer.subscription.deleted", status: "canceled", created: T + 100 })),
    );
    expect(del.status).toBe(200);
    let s = await shop();
    expect(s?.subscriptionStatus).toBe("canceled");
    expect(s?.plan).toBe("free");
    expect(s?.subscriptionEventCreated).toBe(T + 100);

    // Then Stripe redelivers the "active" update from T+50 - a DIFFERENT
    // event id, so the receipt does not catch it. The clock does.
    const stale = await post(
      "/webhooks/stripe",
      sign(subscriptionEvent({ type: "customer.subscription.updated", status: "active", created: T + 50 })),
    );
    expect(stale.status).toBe(200);
    s = await shop();
    expect(s?.subscriptionStatus).toBe("canceled");
    expect(s?.plan).toBe("free");
    expect(s?.subscriptionEventCreated).toBe(T + 100);

    // A genuinely newer event still lands.
    const fresh = await post(
      "/webhooks/stripe",
      sign(subscriptionEvent({ type: "customer.subscription.updated", status: "active", created: T + 200 })),
    );
    expect(fresh.status).toBe(200);
    s = await shop();
    expect(s?.subscriptionStatus).toBe("active");
    expect(s?.subscriptionEventCreated).toBe(T + 200);
  });

  it("one event id delivered to BOTH endpoints is applied once", async () => {
    // A real Payment row for a real appointment, so payment_intent.succeeded
    // has something to land on.
    const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
    const service = await prisma.service.create({
      data: { shopId, name: "Cut", durationMin: 30, price: 50 },
      select: { id: true },
    });
    const startsAt = new Date(Date.now() + 3 * 86_400_000);
    const appt = await prisma.appointment.create({
      data: {
        shopId,
        staffId: staff.id,
        serviceId: service.id,
        firstName: "Both",
        lastName: "Ends",
        status: "BOOKED",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        priceAtBooking: 50,
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    const payment = await prisma.payment.create({
      data: {
        shopId,
        appointmentId: appt.id,
        stripePaymentIntentId: `pi_int_${randomToken(8)}`,
        stripeConnectAccountId: "acct_int",
        mode: "ahead",
        amount: 5000,
        status: "requires_payment_method",
      },
      select: { id: true, stripePaymentIntentId: true },
    });
    const id = evtId();
    const event = {
      id,
      object: "event",
      type: "payment_intent.succeeded",
      livemode: false,
      created: T,
      data: {
        object: {
          object: "payment_intent",
          id: payment.stripePaymentIntentId,
          status: "succeeded",
          amount_received: 5000,
          latest_charge: "ch_int",
          metadata: { paymentId: payment.id, appointmentId: appt.id, shopId },
        },
      },
    };
    const platform = await post("/webhooks/stripe", sign(event));
    expect(platform.status).toBe(200);
    const connect = await post("/webhooks/stripe-connect", sign(event, CONNECT_SECRET));
    expect(connect.status).toBe(200);
    expect(connect.body).toEqual({ received: true, duplicate: true });

    const row = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(row?.status).toBe("succeeded");
    expect(row?.capturedAmount).toBe(5000);
    expect(row?.lastWebhookEventId).toBe(id);
    expect(await prisma.stripeEventReceipt.count({ where: { eventId: id } })).toBe(1);
  });

  it("a handler that throws settles the receipt as failed and asks Stripe to redeliver", async () => {
    // A subscription event with no customer at all: the reducer dereferences
    // `sub.customer.id` and throws. The route must not swallow that into a 200.
    const id = evtId();
    const broken = {
      id,
      object: "event",
      type: "customer.subscription.updated",
      livemode: false,
      created: T + 300,
      data: { object: { object: "subscription", id: SUB_ID, status: "active", metadata: {} } },
    };
    const first = await post("/webhooks/stripe", sign(broken));
    expect(first.status).toBe(500);
    let receipt = await prisma.stripeEventReceipt.findUnique({ where: { eventId: id } });
    expect(receipt?.status).toBe("failed");
    expect(receipt?.lastError).toBeTruthy();
    // The redelivery is re-applied (and fails again the same way), not refused
    // as a duplicate - and the attempt is counted.
    const again = await post("/webhooks/stripe", sign(broken));
    expect(again.status).toBe(500);
    receipt = await prisma.stripeEventReceipt.findUnique({ where: { eventId: id } });
    expect(receipt?.status).toBe("failed");
    expect(receipt?.attempts).toBe(2);
    // The broken event moved nothing.
    const s = await shop();
    expect(s?.subscriptionEventCreated).toBe(T + 200);
  });
});
