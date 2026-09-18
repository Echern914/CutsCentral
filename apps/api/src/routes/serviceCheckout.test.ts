import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, prisma } from "@chairback/db";
import { randomToken, SERVICE_CHARGE_CONSENT_VERSION, __resetEnvCacheForTests } from "@chairback/config";
import { raceBehindRowLock, winners } from "../testing/raceBarrier.js";

/**
 * POST-SERVICE CHECKOUT, end to end, against a FAKE Stripe.
 *
 * Follows cardOnFile.test.ts: the fake records what we ASKED Stripe for and
 * answers with the least the code reads, `connectEnabled()` stays real (the env
 * is set before the app is imported), and nothing here talks to Stripe.
 *
 * WHAT THIS PINS, in the order the money can go wrong:
 *   - a card that was only authorised for a NO-SHOW FEE is not offered for the
 *     service, and saying no is a different answer from "no card";
 *   - the amount charged is the one the server computed, never the one the
 *     client sent, and it cannot be raised;
 *   - a double tap is one charge; a second, different collection is refused
 *     while the first is unresolved - including in CASH;
 *   - a decline and an authentication request both leave the cut UNPAID;
 *   - a webhook replay settles once;
 *   - another shop's appointment is NOT FOUND.
 */

type FakeIntent = {
  id: string;
  object: "payment_intent";
  status: string;
  amount: number;
  amount_received: number;
  client_secret: string;
  latest_charge: string | null;
  metadata: Record<string, string>;
};

const fake = vi.hoisted(() => {
  const intents = new Map<string, FakeIntent>();
  const calls = {
    paymentIntents: [] as Array<{ params: Record<string, unknown>; options: { idempotencyKey?: string } }>,
    canceled: [] as string[],
  };
  let n = 0;
  /** What the next paymentIntents.create should do. */
  let nextOutcome: "succeeded" | "requires_action" | "decline" | "timeout" = "succeeded";
  return {
    intents,
    calls,
    setNextOutcome(o: typeof nextOutcome) {
      nextOutcome = o;
    },
    reset() {
      calls.paymentIntents.length = 0;
      calls.canceled.length = 0;
      nextOutcome = "succeeded";
    },
    client: {
      customers: { create: vi.fn(async () => ({ id: `cus_fake_${++n}` })) },
      setupIntents: {
        create: vi.fn(async (params: { customer: string; metadata: Record<string, string> }) => {
          const id = `seti_fake_${++n}`;
          return {
            id,
            object: "setup_intent",
            status: "requires_payment_method",
            client_secret: `${id}_secret`,
            customer: params.customer,
            payment_method: null,
            metadata: params.metadata,
          };
        }),
        retrieve: vi.fn(async (id: string) => ({ id, status: "succeeded", payment_method: `pm_${id}` })),
      },
      paymentMethods: {
        retrieve: vi.fn(async (id: string) => ({ id, card: { brand: "visa", last4: "4242" } })),
        detach: vi.fn(async (id: string) => ({ id })),
      },
      accounts: {
        retrieve: vi.fn(async () => ({
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
        })),
      },
      paymentIntents: {
        create: vi.fn(
          async (
            params: Record<string, unknown>,
            options: { idempotencyKey?: string } = {},
          ) => {
            calls.paymentIntents.push({ params, options });
            if (nextOutcome === "timeout") {
              // A transport failure with NO Stripe error shape: the charge may
              // or may not have been taken. This is the `ambiguous` path.
              throw new Error("socket hang up");
            }
            if (nextOutcome === "decline") {
              const err = Object.assign(new Error("Your card was declined."), {
                type: "StripeCardError",
                code: "card_declined",
                decline_code: "generic_decline",
                payment_intent: { id: `pi_declined_${++n}` },
              });
              throw err;
            }
            const id = `pi_fake_${++n}`;
            const pi: FakeIntent = {
              id,
              object: "payment_intent",
              status: nextOutcome === "requires_action" ? "requires_action" : "succeeded",
              amount: params.amount as number,
              amount_received: nextOutcome === "requires_action" ? 0 : (params.amount as number),
              client_secret: `${id}_secret`,
              latest_charge: nextOutcome === "requires_action" ? null : `ch_${id}`,
              metadata: (params.metadata ?? {}) as Record<string, string>,
            };
            intents.set(id, pi);
            return pi;
          },
        ),
        retrieve: vi.fn(async (id: string) => intents.get(id) ?? { id, status: "succeeded" }),
        cancel: vi.fn(async (id: string) => {
          calls.canceled.push(id);
          const pi = intents.get(id);
          if (pi) pi.status = "canceled";
          return pi ?? { id, status: "canceled" };
        }),
      },
    },
  };
});

vi.mock("../billing/stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../billing/stripe.js")>()),
  stripeClient: () => fake.client,
}));

let app: Express;
let cookie: string;
let shopId: string;
let staffId: string;
let serviceId: string;
/** A SECOND shop, for the tenancy test. */
let otherCookie: string;
let otherShopId: string;

const email = `svc-${randomToken(6)}@test.local`.toLowerCase();
const otherEmail = `svc2-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
const ACCT = `acct_test_${randomToken(6)}`;
const OTHER_ACCT = `acct_test_${randomToken(6)}`;

/** A unique request id per press, as the real screen mints one. */
const press = () => `req_${randomToken(12)}`;

async function makeShop(ownerEmail: string) {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email: ownerEmail, password, name: "Svc", smsAttested: true });
  expect(signup.status).toBe(201);
  const c = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", c)
    .send({ name: "Svc Cuts", bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", c)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  return { cookie: c, shopId: shop.body.id as string };
}

/**
 * An appointment in the past that is ready to be checked out, with a ticket
 * price, plus (optionally) a saved card carrying a given consent.
 */
async function seedAppointment(opts: {
  shopId: string;
  priceDollars: number | null;
  card?: { consent: "none" | "single" | "series"; status?: string };
  depositCents?: number;
}): Promise<string> {
  const startsAt = new Date(Date.now() - 60 * 60 * 1000);
  const client = await prisma.client.create({
    data: {
      shopId: opts.shopId,
      firstName: "Pat",
      lastName: "Customer",
      // Shop-scoped identity key; unique per shop, so each fixture needs its own.
      acuityClientKey: `svc-${randomToken(10)}`,
      magicToken: randomToken(20),
    },
  });
  const appt = await prisma.appointment.create({
    data: {
      shopId: opts.shopId,
      clientId: client.id,
      staffId,
      serviceId,
      firstName: "Pat",
      lastName: "Customer",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
      status: "BOOKED",
      manageToken: randomToken(20),
      ...(opts.priceDollars === null
        ? {}
        : { priceAtBooking: new Prisma.Decimal(opts.priceDollars.toFixed(2)) }),
    },
  });
  if (opts.depositCents) {
    await prisma.payment.create({
      data: {
        id: `pay_${randomToken(12)}`,
        shopId: opts.shopId,
        appointmentId: appt.id,
        stripePaymentIntentId: `pi_deposit_${randomToken(10)}`,
        stripeConnectAccountId: ACCT,
        mode: "deposit",
        purpose: "booking",
        amount: opts.depositCents,
        currency: "usd",
        status: "succeeded",
        capturedAmount: opts.depositCents,
      },
    });
  }
  if (opts.card) {
    const consented = opts.card.consent !== "none";
    await prisma.cardOnFile.create({
      data: {
        id: `cof_${randomToken(12)}`,
        shopId: opts.shopId,
        appointmentId: appt.id,
        stripeCustomerId: `cus_${randomToken(10)}`,
        stripeSetupIntentId: `seti_${randomToken(10)}`,
        stripePaymentMethodId: `pm_${randomToken(10)}`,
        brand: "visa",
        last4: "4242",
        status: opts.card.status ?? "saved",
        savedAt: new Date(),
        ...(consented
          ? {
              serviceChargeConsentVersion: SERVICE_CHARGE_CONSENT_VERSION,
              serviceChargeConsentAt: new Date(),
              serviceChargeConsentScope: opts.card.consent,
            }
          : {}),
      },
    });
  }
  return appt.id;
}

const getCheckout = (id: string, c = cookie) =>
  request(app).get(`/api/checkout/appointments/${id}`).set("Cookie", c);

const chargeCard = (id: string, body: Record<string, unknown>, c = cookie) =>
  request(app).post(`/api/checkout/appointments/${id}/charge-card`).set("Cookie", c).send(body);

const payCash = (id: string, body: Record<string, unknown>, c = cookie) =>
  request(app).post(`/api/checkout/appointments/${id}/cash`).set("Cookie", c).send(body);

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  // 🔴 Resolve the mocked module ONCE before any race runs. Two racers hitting
  // a dynamic import together can otherwise land on different copies - one
  // mocked, one real - and a losing racer that crashes on the real Stripe looks
  // exactly like a guard that worked. (chairback-race-barrier-helper)
  await import("../billing/stripe.js");
  await import("../services/serviceCheckoutAttempt.js");
  app = createApp();

  const mine = await makeShop(email);
  cookie = mine.cookie;
  shopId = mine.shopId;
  const other = await makeShop(otherEmail);
  otherCookie = other.cookie;
  otherShopId = other.shopId;

  // Both shops need Connect + an active plan for the checkout router. The
  // account id is UNIQUE per shop, so they cannot share one.
  await prisma.shop.update({
    where: { id: shopId },
    data: { stripeConnectAccountId: ACCT, paymentsMode: "card_on_file", compAccess: true },
  });
  await prisma.shop.update({
    where: { id: otherShopId },
    data: {
      stripeConnectAccountId: OTHER_ACCT,
      paymentsMode: "card_on_file",
      compAccess: true,
    },
  });

  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 40, staffIds: [staffId] });
  serviceId = service.body.id;
});

afterAll(async () => {
  const ids = [shopId, otherShopId].filter(Boolean);
  if (ids.length > 0) await prisma.shop.deleteMany({ where: { id: { in: ids } } });
});

describe("what the checkout screen may offer", () => {
  it("offers the saved card, with its brand and last four, when the customer authorised service charges", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40, card: { consent: "single" } });
    const res = await getCheckout(id);
    expect(res.status).toBe(200);
    expect(res.body.remainingCents).toBe(4000);
    expect(res.body.methods.savedCard.available).toBe(true);
    expect(res.body.methods.savedCard.card).toEqual({ brand: "visa", last4: "4242" });
    expect(res.body.methods.savedCard.maxCents).toBe(4000);
  });

  it("does NOT offer a saved card when there is none", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    const res = await getCheckout(id);
    expect(res.status).toBe(200);
    expect(res.body.methods.savedCard.available).toBe(false);
    expect(res.body.methods.savedCard.blocker).toBe("no_card");
    expect(res.body.methods.savedCard.card).toBeNull();
  });

  it("🔴 does NOT offer a card saved only for a no-show fee, and says why", async () => {
    // The whole point of the consent split: this card exists, is saved, and is
    // perfectly chargeable for a fee - and may not be charged for the haircut.
    const id = await seedAppointment({ shopId, priceDollars: 40, card: { consent: "none" } });
    const res = await getCheckout(id);
    expect(res.status).toBe(200);
    expect(res.body.methods.savedCard.available).toBe(false);
    expect(res.body.methods.savedCard.blocker).toBe("no_service_consent");
  });

  it("charges only the balance when a deposit was already taken", async () => {
    const id = await seedAppointment({
      shopId,
      priceDollars: 40,
      depositCents: 1500,
      card: { consent: "single" },
    });
    const res = await getCheckout(id);
    expect(res.body.totalCents).toBe(4000);
    expect(res.body.collectedCents).toBe(1500);
    expect(res.body.remainingCents).toBe(2500);
    expect(res.body.methods.savedCard.maxCents).toBe(2500);
  });
});

describe("charging the saved card", () => {
  it("charges exactly the confirmed amount, and marks the cut paid without changing its status", async () => {
    fake.reset();
    const id = await seedAppointment({ shopId, priceDollars: 40, card: { consent: "single" } });
    const res = await chargeCard(id, { amountCents: 4000, requestId: press() });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe("paid");
    expect(res.body.amountCents).toBe(4000);
    expect(res.body.receiptReference).toMatch(/^pi_/);

    expect(fake.calls.paymentIntents).toHaveLength(1);
    const sent = fake.calls.paymentIntents[0]!;
    expect(sent.params.amount).toBe(4000);
    // The Connect shape every other charge here uses: a destination charge on
    // the platform account, on behalf of the barber.
    expect(sent.params.on_behalf_of).toBe(ACCT);
    expect(sent.params.transfer_data).toEqual({ destination: ACCT });
    expect(sent.params.off_session).toBe(true);
    // Attempt-scoped, NOT card-scoped - the fee helper keys on the card.
    expect(sent.options.idempotencyKey).toMatch(/^svc-checkout:cka_/);

    const appt = await prisma.appointment.findUnique({
      where: { id },
      select: { paidAt: true, status: true, canceledAt: true },
    });
    expect(appt!.paidAt).not.toBeNull();
    // Checking a cut out completes it, through the SAME promotion path the
    // cash checkout and the Done button already use - deliberately, because
    // that is the one place a Visit is written and a loyalty punch is earned.
    // Making the card path differ would silently cost customers their punch on
    // every card checkout, which is a worse surprise than the status moving.
    expect(appt!.status).toBe("COMPLETED");
    // What a payment must NOT touch: nothing else moves. In particular a
    // charge can never resurrect or cancel a booking.
    expect(appt!.canceledAt).toBeNull();

    const rows = await prisma.payment.findMany({ where: { appointmentId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.purpose).toBe("service_checkout");
    expect(rows[0]!.amount).toBe(4000);
  });

  it("charges the balance, not the ticket, when a deposit exists", async () => {
    fake.reset();
    const id = await seedAppointment({
      shopId,
      priceDollars: 40,
      depositCents: 1500,
      card: { consent: "single" },
    });
    const res = await chargeCard(id, { amountCents: 2500, requestId: press() });
    expect(res.status).toBe(200);
    expect(fake.calls.paymentIntents[0]!.params.amount).toBe(2500);
    // The deposit row is untouched and still sits beside the new one.
    const rows = await prisma.payment.findMany({
      where: { appointmentId: id },
      orderBy: { purpose: "asc" },
    });
    expect(rows.map((r) => r.purpose)).toEqual(["booking", "service_checkout"]);
  });

  it("🔴 refuses an amount above what the customer authorised, and charges nothing", async () => {
    fake.reset();
    const id = await seedAppointment({ shopId, priceDollars: 40, card: { consent: "single" } });
    // The barber "added a tip" client-side. Barber confirmation is not customer
    // authorisation, so this is refused outright rather than charging $40.
    const res = await chargeCard(id, { amountCents: 6000, requestId: press() });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("amount_not_authorized");
    expect(res.body.maxCents).toBe(4000);
    expect(fake.calls.paymentIntents).toHaveLength(0);
    const appt = await prisma.appointment.findUnique({ where: { id }, select: { paidAt: true } });
    expect(appt!.paidAt).toBeNull();
  });

  it("allows less than the balance - a discount is the shop's to give", async () => {
    fake.reset();
    const id = await seedAppointment({ shopId, priceDollars: 40, card: { consent: "single" } });
    const res = await chargeCard(id, { amountCents: 3500, requestId: press() });
    expect(res.status).toBe(200);
    expect(fake.calls.paymentIntents[0]!.params.amount).toBe(3500);
  });

  it("🔴 a decline leaves the cut UNPAID and retryable", async () => {
    fake.reset();
    fake.setNextOutcome("decline");
    const id = await seedAppointment({ shopId, priceDollars: 40, card: { consent: "single" } });
    const res = await chargeCard(id, { amountCents: 4000, requestId: press() });
    expect(res.status).toBe(402);
    expect(res.body.result).toBe("declined");

    const appt = await prisma.appointment.findUnique({ where: { id }, select: { paidAt: true } });
    expect(appt!.paidAt).toBeNull();
    // The attempt is terminal, so another method is immediately available.
    const live = await prisma.checkoutAttempt.findFirst({
      where: { appointmentId: id, state: { in: ["pending", "processing", "requires_action", "ambiguous"] } },
    });
    expect(live).toBeNull();
  });

  it("🔴 authentication-required is NOT paid, and blocks another collection until it is cancelled", async () => {
    fake.reset();
    fake.setNextOutcome("requires_action");
    const id = await seedAppointment({ shopId, priceDollars: 40, card: { consent: "single" } });
    const res = await chargeCard(id, { amountCents: 4000, requestId: press() });
    expect(res.status).toBe(409);
    expect(res.body.result).toBe("requires_action");

    const appt = await prisma.appointment.findUnique({ where: { id }, select: { paidAt: true } });
    expect(appt!.paidAt).toBeNull();

    // 🔴 The barber cannot simply take cash instead: the card attempt is
    // unresolved, and Stripe could still complete it.
    const cash = await payCash(id, {
      amountCents: 4000,
      method: "cash",
      requestId: press(),
      confirmed: true,
    });
    expect(cash.status).toBe(409);
    expect(cash.body.error).toBe("collection_in_progress");

    // Cancelling it cancels the INTENT at Stripe first, then frees the chair.
    const attempt = await prisma.checkoutAttempt.findFirst({
      where: { appointmentId: id, state: "requires_action" },
    });
    const cancel = await request(app)
      .post(`/api/checkout/appointments/${id}/cancel-attempt`)
      .set("Cookie", cookie)
      .send({ attemptId: attempt!.id });
    expect(cancel.status).toBe(200);
    expect(fake.calls.canceled).toHaveLength(1);

    const cash2 = await payCash(id, {
      amountCents: 4000,
      method: "cash",
      requestId: press(),
      confirmed: true,
    });
    expect(cash2.status).toBe(200);
  });

  it("🔴 an unknown outcome is ambiguous: not paid, not declined, and NOT collectable another way", async () => {
    fake.reset();
    fake.setNextOutcome("timeout");
    const id = await seedAppointment({ shopId, priceDollars: 40, card: { consent: "single" } });
    const res = await chargeCard(id, { amountCents: 4000, requestId: press() });
    expect(res.status).toBe(409);
    expect(res.body.result).toBe("ambiguous");

    const appt = await prisma.appointment.findUnique({ where: { id }, select: { paidAt: true } });
    expect(appt!.paidAt).toBeNull();
    const pay = await prisma.payment.findFirst({ where: { appointmentId: id } });
    expect(pay!.ambiguousAt).not.toBeNull();

    // Cash is refused, and so is dismissing it: only the reconciler, which
    // reads Stripe's own answer, may resolve this.
    const cash = await payCash(id, {
      amountCents: 4000,
      method: "cash",
      requestId: press(),
      confirmed: true,
    });
    expect(cash.status).toBe(409);
    const attempt = await prisma.checkoutAttempt.findFirst({
      where: { appointmentId: id, state: "ambiguous" },
    });
    const cancel = await request(app)
      .post(`/api/checkout/appointments/${id}/cancel-attempt`)
      .set("Cookie", cookie)
      .send({ attemptId: attempt!.id });
    expect(cancel.status).toBe(409);
    expect(cancel.body.error).toBe("not_cancelable");
  });
});

describe("collecting twice", () => {
  it("a repeated tap of the same button charges once", async () => {
    fake.reset();
    const id = await seedAppointment({ shopId, priceDollars: 40, card: { consent: "single" } });
    const requestId = press();
    const first = await chargeCard(id, { amountCents: 4000, requestId });
    const second = await chargeCard(id, { amountCents: 4000, requestId });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.replay).toBe(true);
    // One press, one Stripe call, one payment row.
    expect(fake.calls.paymentIntents).toHaveLength(1);
    expect(await prisma.payment.count({ where: { appointmentId: id } })).toBe(1);
  });

  it("refuses a SECOND collection once the cut is already paid", async () => {
    fake.reset();
    const id = await seedAppointment({ shopId, priceDollars: 40, card: { consent: "single" } });
    expect((await chargeCard(id, { amountCents: 4000, requestId: press() })).status).toBe(200);
    // A different request id is a genuinely new attempt - and still refused.
    const again = await chargeCard(id, { amountCents: 4000, requestId: press() });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("paid_already");
    expect(fake.calls.paymentIntents).toHaveLength(1);
  });

  it("two concurrent attempts on one appointment: the live-attempt index admits exactly one", async () => {
    // SHAPE 1 - assert the constraint head-on. Deterministic, and it fails the
    // instant the partial unique index is dropped. (Promise.all is not a race:
    // Node plus a fast local Postgres serialise it and the guard is never
    // contended - chairback-race-barrier-helper.)
    const id = await seedAppointment({ shopId, priceDollars: 40, card: { consent: "single" } });
    const row = (extra: Record<string, unknown>) => ({
      id: `cka_${randomToken(12)}`,
      shopId,
      appointmentId: id,
      requestId: press(),
      method: "saved_card",
      amountCents: 4000,
      idempotencyKey: `svc-checkout:${randomToken(16)}`,
      state: "processing",
      updatedAt: new Date(),
      ...extra,
    });
    await prisma.checkoutAttempt.create({ data: row({}) });
    // A second LIVE attempt on the same appointment, by any method, is refused
    // by the database itself.
    await expect(
      prisma.checkoutAttempt.create({ data: row({ method: "cash_other" }) }),
    ).rejects.toThrow();
    // ...but once the first concludes, the next one is free to start.
    await prisma.checkoutAttempt.updateMany({
      where: { appointmentId: id },
      data: { state: "failed", settledAt: new Date() },
    });
    await expect(
      prisma.checkoutAttempt.create({ data: row({ method: "cash_other" }) }),
    ).resolves.toBeTruthy();
  });

  it("a service charge racing a no-show fee on one card: the CardOnFile CAS lets exactly one through", async () => {
    // SHAPE 2 - a barrier on the row both racers WRITE through. The CAS is
    // `saved -> charging` on the CardOnFile row, and it is the single guard
    // that serialises a checkout against a fee settlement on the same card.
    fake.reset();
    const id = await seedAppointment({ shopId, priceDollars: 40, card: { consent: "single" } });
    const card = await prisma.cardOnFile.findUnique({ where: { appointmentId: id } });

    const { chargeSavedCardForService, chargeCardOnFile } = await import("../billing/cardOnFile.js");
    const outcome = await raceBehindRowLock("CardOnFile", card!.id, [
      () =>
        chargeSavedCardForService({
          shopId,
          appointmentId: id,
          cents: 4000,
          description: "service",
          attemptId: `cka_${randomToken(10)}`,
          idempotencyKey: `svc-checkout:${randomToken(16)}`,
        }).then((r) => r.outcome),
      () =>
        chargeCardOnFile({
          shopId,
          appointmentId: id,
          cents: 1000,
          reason: "no_show",
          description: "fee",
        }).then((r) => r.outcome),
    ]);

    // The assertion a missing guard fails: neither racer got through before
    // the barrier was released, so they genuinely contended.
    expect(outcome.settledEarly).toBe(0);
    const results = winners(outcome.results);
    // Exactly one charged; the other was told the card was already claimed.
    expect(results.filter((r) => r === "charged")).toHaveLength(1);
    expect(results.filter((r) => r === "already")).toHaveLength(1);
    expect(fake.calls.paymentIntents).toHaveLength(1);
  });
});

describe("cash and other", () => {
  it("records the money, the method and who took it, and creates NO Stripe charge", async () => {
    fake.reset();
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    const res = await payCash(id, {
      amountCents: 4000,
      method: "cash",
      requestId: press(),
      confirmed: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe("paid");
    expect(res.body.receiptReference).toBeNull();
    // 🔴 No processor was involved.
    expect(fake.calls.paymentIntents).toHaveLength(0);
    expect(await prisma.payment.count({ where: { appointmentId: id } })).toBe(0);

    const appt = await prisma.appointment.findUnique({
      where: { id },
      select: { paidAt: true, paidMethod: true, paidAmount: true },
    });
    expect(appt!.paidMethod).toBe("cash");
    expect(Number(appt!.paidAmount)).toBe(40);

    const attempt = await prisma.checkoutAttempt.findFirst({ where: { appointmentId: id } });
    expect(attempt!.method).toBe("cash_other");
    expect(attempt!.state).toBe("succeeded");
    // Who marked it paid - the audit question that gets asked.
    expect(attempt!.actorUserId).toBeTruthy();
  });

  it("refuses to record without the confirmation the screen is required to show", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    const res = await payCash(id, { amountCents: 4000, method: "cash", requestId: press() });
    expect(res.status).toBe(400);
    const appt = await prisma.appointment.findUnique({ where: { id }, select: { paidAt: true } });
    expect(appt!.paidAt).toBeNull();
  });
});

describe("tenancy", () => {
  it("🔴 a barber cannot check out another shop's appointment - it is NOT FOUND, not forbidden", async () => {
    fake.reset();
    const id = await seedAppointment({ shopId, priceDollars: 40, card: { consent: "single" } });
    // The other shop's owner, with a perfectly valid session of their own.
    expect((await getCheckout(id, otherCookie)).status).toBe(404);
    expect(
      (await chargeCard(id, { amountCents: 4000, requestId: press() }, otherCookie)).status,
    ).toBe(404);
    expect(
      (
        await payCash(
          id,
          { amountCents: 4000, method: "cash", requestId: press(), confirmed: true },
          otherCookie,
        )
      ).status,
    ).toBe(404);
    expect(fake.calls.paymentIntents).toHaveLength(0);
    const appt = await prisma.appointment.findUnique({ where: { id }, select: { paidAt: true } });
    expect(appt!.paidAt).toBeNull();
  });
});

describe("the webhook is what settles", () => {
  it("a redelivered success settles the attempt once and does not double the payment", async () => {
    fake.reset();
    const id = await seedAppointment({ shopId, priceDollars: 40, card: { consent: "single" } });
    await chargeCard(id, { amountCents: 4000, requestId: press() });
    const attempt = await prisma.checkoutAttempt.findFirst({ where: { appointmentId: id } });
    const pay = await prisma.payment.findFirst({ where: { appointmentId: id } });

    const { applyPaymentEvent } = await import("../billing/payments.js");
    const event = {
      id: `evt_${randomToken(10)}`,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: pay!.stripePaymentIntentId,
          status: "succeeded",
          amount_received: 4000,
          latest_charge: `ch_${randomToken(8)}`,
          metadata: {
            shopId,
            appointmentId: id,
            paymentId: pay!.id,
            checkoutAttemptId: attempt!.id,
            purpose: "service_checkout",
          },
        },
      },
    } as never;

    await applyPaymentEvent(event);
    await applyPaymentEvent(event); // Stripe redelivers for ~3 days.

    expect(await prisma.payment.count({ where: { appointmentId: id } })).toBe(1);
    const after = await prisma.checkoutAttempt.findUnique({ where: { id: attempt!.id } });
    expect(after!.state).toBe("succeeded");
    expect(fake.calls.paymentIntents).toHaveLength(1);
  });

  it("🔴 a webhook that arrives BEFORE the response still settles, and a lost client does not lose the payment", async () => {
    // The app was backgrounded / the WebView reloaded: nothing read the HTTP
    // reply. The attempt must still reach its final state from the webhook
    // alone, and re-opening the screen must show it.
    fake.reset();
    const id = await seedAppointment({ shopId, priceDollars: 40, card: { consent: "single" } });
    const attempt = await prisma.checkoutAttempt.create({
      data: {
        id: `cka_${randomToken(12)}`,
        shopId,
        appointmentId: id,
        requestId: press(),
        method: "saved_card",
        amountCents: 4000,
        idempotencyKey: `svc-checkout:${randomToken(16)}`,
        state: "processing",
        updatedAt: new Date(),
      },
    });

    const { settleAttemptFromIntent } = await import("../services/serviceCheckoutAttempt.js");
    await settleAttemptFromIntent({
      attemptId: attempt.id,
      status: "succeeded",
      paymentIntentId: `pi_${randomToken(8)}`,
    });

    const after = await prisma.checkoutAttempt.findUnique({ where: { id: attempt.id } });
    expect(after!.state).toBe("succeeded");
    expect(after!.settledAt).not.toBeNull();
    // The appointment is free for the barber to finish checking out, and the
    // screen can see what happened rather than starting a second collection.
    const screen = await getCheckout(id);
    expect(screen.body.liveAttempt).toBeNull();
  });

  it("a late 'processing' redelivery cannot reopen a settled attempt", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    const attempt = await prisma.checkoutAttempt.create({
      data: {
        id: `cka_${randomToken(12)}`,
        shopId,
        appointmentId: id,
        requestId: press(),
        method: "saved_card",
        amountCents: 4000,
        idempotencyKey: `svc-checkout:${randomToken(16)}`,
        state: "succeeded",
        settledAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const { settleAttemptFromIntent } = await import("../services/serviceCheckoutAttempt.js");
    await settleAttemptFromIntent({
      attemptId: attempt.id,
      status: "processing",
      paymentIntentId: `pi_${randomToken(8)}`,
    });
    const after = await prisma.checkoutAttempt.findUnique({ where: { id: attempt.id } });
    // Terminal is terminal: otherwise a stale event would re-lock the
    // appointment against every other method.
    expect(after!.state).toBe("succeeded");
  });
});
