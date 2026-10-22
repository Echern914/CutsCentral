import request from "supertest";
import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import type { Express } from "express";

/**
 * A LEAKED WEBHOOK SECRET MUST NOT BE ABLE TO FAKE A PAYMENT.
 *
 * The webhook secret lives in the hosting environment - on 2026-10-21 a host
 * reported its customers' environment variables may have been read. With it,
 * anyone can sign a `payment_intent.succeeded` that names a real PaymentIntent
 * id (those ids are in our database) and the handler would mark the payment
 * succeeded and book the unpaid hold. The signature cannot tell.
 *
 * Pinned (billing/stripeEventConfirm.ts): after the signature, the event is
 * fetched back from Stripe by id, and only Stripe's copy is acted on.
 */

const WEBHOOK_SECRET = "whsec_confirm_" + randomToken(6);
const CONNECT_SECRET = "whsec_confirmc_" + randomToken(6);
const email = `confirm-${randomToken(6)}@test.local`;

let app: Express;
let shopId: string;
let setFetcher: typeof import("../billing/stripeEventConfirm.js").__setStripeEventFetcherForTests;
const eventIds: string[] = [];

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_PRICE_ID = "price_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();
  setFetcher = (await import("../billing/stripeEventConfirm.js")).__setStripeEventFetcherForTests;

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Confirm Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Confirm Cuts", bookingUrl: "https://confirm.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
});

afterEach(() => setFetcher(null));

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
  const id = `evt_cf_${randomToken(8)}`;
  eventIds.push(id);
  return id;
}

function sign(event: Record<string, unknown>, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const header = new Stripe("sk_test_dummy").webhooks.generateTestHeaderString({ payload, secret });
  return { payload, header };
}

function post(path: string, body: { payload: string; header: string }) {
  return request(app)
    .post(path)
    .set("Content-Type", "application/json")
    .set("stripe-signature", body.header)
    .send(body.payload);
}

/** A real, UNPAID booking payment: what a forger would want marked paid. */
async function unpaidPayment() {
  const staff = await prisma.staff.create({ data: { shopId, name: `S${randomToken(3)}` }, select: { id: true } });
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 50 },
    select: { id: true },
  });
  const startsAt = new Date(Date.now() + 3 * 86_400_000 + Math.floor(Math.random() * 1e6));
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId: staff.id,
      serviceId: service.id,
      firstName: "Unpaid",
      lastName: "Hold",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: 50,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return prisma.payment.create({
    data: {
      shopId,
      appointmentId: appt.id,
      stripePaymentIntentId: `pi_cf_${randomToken(8)}`,
      stripeConnectAccountId: "acct_cf",
      mode: "ahead",
      amount: 5000,
      status: "requires_payment_method",
    },
    select: { id: true, appointmentId: true, stripePaymentIntentId: true },
  });
}

function succeeded(p: { id: string; appointmentId: string; stripePaymentIntentId: string | null }, id = evtId()) {
  return {
    id,
    object: "event",
    type: "payment_intent.succeeded",
    livemode: false,
    created: 1_800_000_000,
    data: {
      object: {
        object: "payment_intent",
        id: p.stripePaymentIntentId,
        status: "succeeded",
        amount_received: 5000,
        latest_charge: "ch_cf",
        metadata: { paymentId: p.id, appointmentId: p.appointmentId, shopId },
      },
    },
  };
}

const paymentStatus = (id: string) =>
  prisma.payment.findUniqueOrThrow({ where: { id }, select: { status: true } }).then((r) => r.status);
const receipts = (eventId: string) => prisma.stripeEventReceipt.count({ where: { eventId } });

describe("🔴 a correctly signed event Stripe never sent", () => {
  it("is refused, the unpaid booking stays unpaid, and nothing is recorded", async () => {
    const p = await unpaidPayment();
    const forged = succeeded(p);
    setFetcher(async () => null); // Stripe: no such event
    const res = await post("/webhooks/stripe", sign(forged));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "unconfirmed_event" });
    expect(await paymentStatus(p.id)).toBe("requires_payment_method");
    expect(await receipts(forged.id)).toBe(0);
  });

  it("is refused on the Connect endpoint too", async () => {
    const p = await unpaidPayment();
    const forged = succeeded(p);
    setFetcher(async () => null);
    const res = await post("/webhooks/stripe-connect", sign(forged, CONNECT_SECRET));
    expect(res.status).toBe(400);
    expect(await paymentStatus(p.id)).toBe("requires_payment_method");
  });
});

describe("a real event id with a doctored body", () => {
  it("🔴 is handled with STRIPE's copy - the doctoring changes nothing", async () => {
    const p = await unpaidPayment();
    const doctored = succeeded(p); // names OUR intent
    // Stripe's real event under that id was about someone else's intent.
    const real = {
      ...doctored,
      data: { object: { ...doctored.data.object, id: `pi_other_${randomToken(6)}`, metadata: {} } },
    };
    setFetcher(async () => real as unknown as Stripe.Event);
    const res = await post("/webhooks/stripe", sign(doctored));
    expect(res.status).toBe(200);
    expect(await paymentStatus(p.id)).toBe("requires_payment_method");
  });

  it("is refused when Stripe's event under that id is a different type", async () => {
    const p = await unpaidPayment();
    const doctored = succeeded(p);
    setFetcher(async () => ({ ...doctored, type: "payment_intent.created" }) as unknown as Stripe.Event);
    const res = await post("/webhooks/stripe", sign(doctored));
    expect(res.status).toBe(400);
    expect(await paymentStatus(p.id)).toBe("requires_payment_method");
  });
});

describe("Stripe cannot be asked", () => {
  it("answers 503 and records nothing, so Stripe's redelivery is processed in full", async () => {
    const p = await unpaidPayment();
    const event = succeeded(p);
    setFetcher(async () => {
      throw Object.assign(new Error("connection reset"), { type: "StripeConnectionError" });
    });
    const res = await post("/webhooks/stripe", sign(event));
    expect(res.status).toBe(503);
    expect(await receipts(event.id)).toBe(0);

    // The redelivery, once Stripe answers, is applied.
    setFetcher(async (signed) => signed);
    const again = await post("/webhooks/stripe", sign(event));
    expect(again.status).toBe(200);
    expect(await paymentStatus(p.id)).toBe("succeeded");
  });
});

describe("a genuine event", () => {
  it("is applied exactly as before", async () => {
    const p = await unpaidPayment();
    setFetcher(async (signed) => signed);
    const res = await post("/webhooks/stripe", sign(succeeded(p)));
    expect(res.status).toBe(200);
    expect(await paymentStatus(p.id)).toBe("succeeded");
  });
});
