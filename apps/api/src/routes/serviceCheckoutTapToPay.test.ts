import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, prisma } from "@chairback/db";
import { randomToken, SERVICE_CHARGE_CONSENT_VERSION, __resetEnvCacheForTests } from "@chairback/config";

/**
 * TAP TO PAY, the server half, against a FAKE Stripe.
 *
 * 🔴 WHAT THIS FILE CANNOT TELL YOU. Nothing here proves Tap to Pay works. It
 * proves the SERVER behaves, and the server is the half that owns the money:
 * what is asked of Stripe, what the attempt ledger allows while a card may
 * still be tapped, and what happens when the answer never comes. The NFC
 * hardware, the entitlement and the customer's card are not modelled and cannot
 * be - see `docs/service-checkout.md` for the real-device script that is the
 * only thing that may be called proof.
 *
 * THE DIFFERENCE FROM A SAVED CARD, which is why this is its own file: a saved
 * card is charged in ONE request and either works or does not. A contactless
 * collection is TWO - mint an intent here, present a card over there - and
 * between them there is a window where money may arrive without this server
 * doing anything. Everything below is about that window.
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
    paymentIntents: [] as Array<{
      params: Record<string, unknown>;
      options: { idempotencyKey?: string };
    }>,
    canceled: [] as string[],
  };
  let n = 0;
  /** When set, the next paymentIntents.create throws instead of answering. */
  let nextCreate: "ok" | "refuse" | "timeout" = "ok";
  return {
    intents,
    calls,
    setNextCreate(o: typeof nextCreate) {
      nextCreate = o;
    },
    reset() {
      calls.paymentIntents.length = 0;
      calls.canceled.length = 0;
      nextCreate = "ok";
    },
    /** The customer taps their card and it works. */
    tap(id: string) {
      const pi = intents.get(id);
      if (!pi) throw new Error(`no such intent ${id}`);
      pi.status = "succeeded";
      pi.amount_received = pi.amount;
      pi.latest_charge = `ch_${id}`;
    },
    /** The customer taps and the card is declined at the reader. */
    tapDeclined(id: string) {
      const pi = intents.get(id);
      if (!pi) throw new Error(`no such intent ${id}`);
      pi.status = "requires_payment_method";
    },
    client: {
      customers: { create: vi.fn(async () => ({ id: `cus_fake_${++n}` })) },
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
      terminal: {
        connectionTokens: { create: vi.fn(async () => ({ secret: `pst_test_${++n}` })) },
      },
      paymentIntents: {
        create: vi.fn(
          async (params: Record<string, unknown>, options: { idempotencyKey?: string } = {}) => {
            calls.paymentIntents.push({ params, options });
            if (nextCreate === "timeout") throw new Error("socket hang up");
            if (nextCreate === "refuse") {
              throw Object.assign(new Error("Invalid request"), {
                type: "StripeInvalidRequestError",
                code: "parameter_invalid_integer",
              });
            }
            // 🔴 A CARD-PRESENT INTENT IS BORN UNPAID and stays that way until
            // somebody physically presents a card, whereas a saved-card charge
            // is created WITH `confirm: true` and answers immediately. Modelling
            // both matters here: several tests below use a saved card to prove
            // Tap to Pay interacts with it correctly, and a fake that answered
            // `succeeded` for everything would quietly turn the contactless
            // tests into saved-card tests that pass for the wrong reason.
            const cardPresent = Array.isArray(params.payment_method_types)
              ? (params.payment_method_types as string[]).includes("card_present")
              : false;
            const id = cardPresent ? `pi_cp_${++n}` : `pi_saved_${++n}`;
            const pi: FakeIntent = {
              id,
              object: "payment_intent",
              status: cardPresent ? "requires_payment_method" : "succeeded",
              amount: params.amount as number,
              amount_received: cardPresent ? 0 : (params.amount as number),
              client_secret: `${id}_secret`,
              latest_charge: cardPresent ? null : `ch_${id}`,
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
let otherCookie: string;
let otherShopId: string;

const email = `t2p-${randomToken(6)}@test.local`.toLowerCase();
const otherEmail = `t2p2-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
const ACCT = `acct_test_${randomToken(6)}`;
const OTHER_ACCT = `acct_test_${randomToken(6)}`;
/** 250 bps, so "the fee is exactly 2% and a half" is an assertion, not a zero. */
const FEE_BPS = 250;

const press = () => `req_${randomToken(12)}`;

async function makeShop(ownerEmail: string) {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email: ownerEmail, password, name: "T2P", smsAttested: true });
  expect(signup.status).toBe(201);
  const c = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", c)
    .send({ name: "Tap Cuts", bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", c)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  return { cookie: c, shopId: shop.body.id as string };
}

async function seedAppointment(opts: {
  shopId: string;
  priceDollars: number | null;
  card?: { consent: "none" | "single"; status?: string };
  depositCents?: number;
}): Promise<string> {
  const startsAt = new Date(Date.now() - 60 * 60 * 1000);
  const client = await prisma.client.create({
    data: {
      shopId: opts.shopId,
      firstName: "Pat",
      lastName: "Customer",
      acuityClientKey: `t2p-${randomToken(10)}`,
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

const tapIntent = (id: string, body: Record<string, unknown>, c = cookie) =>
  request(app).post(`/api/checkout/appointments/${id}/tap-to-pay-intent`).set("Cookie", c).send(body);

const tapSettle = (id: string, body: Record<string, unknown>, c = cookie) =>
  request(app).post(`/api/checkout/appointments/${id}/tap-to-pay-settle`).set("Cookie", c).send(body);

const payCash = (id: string, body: Record<string, unknown>, c = cookie) =>
  request(app).post(`/api/checkout/appointments/${id}/cash`).set("Cookie", c).send(body);

const chargeCard = (id: string, body: Record<string, unknown>, c = cookie) =>
  request(app).post(`/api/checkout/appointments/${id}/charge-card`).set("Cookie", c).send(body);

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  process.env.SERVICE_CHECKOUT_ENABLED = "true";
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  await import("../billing/stripe.js");
  await import("../services/serviceCheckoutAttempt.js");
  app = createApp();

  const mine = await makeShop(email);
  cookie = mine.cookie;
  shopId = mine.shopId;
  const other = await makeShop(otherEmail);
  otherCookie = other.cookie;
  otherShopId = other.shopId;

  await prisma.shop.update({
    where: { id: shopId },
    data: {
      stripeConnectAccountId: ACCT,
      paymentsMode: "card_on_file",
      compAccess: true,
      rewardsEnabled: true,
      platformFeeBps: FEE_BPS,
    },
  });
  await prisma.shop.update({
    where: { id: otherShopId },
    data: { stripeConnectAccountId: OTHER_ACCT, paymentsMode: "card_on_file", compAccess: true },
  });

  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 40, staffIds: [staffId] });
  serviceId = service.body.id;
});

beforeEach(() => {
  fake.reset();
});

afterAll(async () => {
  const ids = [shopId, otherShopId].filter(Boolean);
  if (ids.length > 0) await prisma.shop.deleteMany({ where: { id: { in: ids } } });
});

describe("what the screen is told about Tap to Pay", () => {
  it("reports the half the server knows: the flag and an account for the money", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    const res = await getCheckout(id);
    expect(res.status).toBe(200);
    expect(res.body.methods.tapToPay.available).toBe(true);
    expect(res.body.methods.tapToPay.blocker).toBeNull();
    expect(res.body.methods.tapToPay.dueCents).toBe(4000);
  });

  it("offers it with NO card on file - a contactless card is not a saved one", async () => {
    // The point of the method: a customer who refused to keep a card can still
    // pay at the chair with their phone or their card.
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    const res = await getCheckout(id);
    expect(res.body.methods.savedCard.available).toBe(false);
    expect(res.body.methods.savedCard.blocker).toBe("no_card");
    expect(res.body.methods.tapToPay.available).toBe(true);
  });

  it("does not offer it once the cut is paid", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    const cash = await payCash(id, {
      amountCents: 4000,
      method: "cash",
      requestId: press(),
      confirmed: true,
    });
    expect(cash.status).toBe(200);
    const res = await getCheckout(id);
    expect(res.body.methods.tapToPay.available).toBe(false);
  });
});

describe("minting the intent", () => {
  it("asks Stripe for a card-present destination charge with the exact fee", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    const res = await tapIntent(id, { amountCents: 4000, requestId: press() });
    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toMatch(/_secret$/);
    expect(fake.calls.paymentIntents).toHaveLength(1);

    const sent = fake.calls.paymentIntents[0]!;
    expect(sent.params.amount).toBe(4000);
    expect(sent.params.payment_method_types).toEqual(["card_present"]);
    expect(sent.params.capture_method).toBe("automatic");
    // The Connect shape this whole codebase uses: platform key, money destined
    // for the barber, never a Stripe-Account header.
    expect(sent.params.on_behalf_of).toBe(ACCT);
    expect(sent.params.transfer_data).toEqual({ destination: ACCT });
    expect(sent.params.application_fee_amount).toBe(100); // 250 bps of 4000
    // 🔴 Both metadata keys are load-bearing: one settles the attempt from the
    // webhook, the other keeps the hold-refund path away from earned money.
    const meta = sent.params.metadata as Record<string, string>;
    expect(meta.checkoutAttemptId).toBe(res.body.attemptId);
    expect(meta.purpose).toBe("service_checkout");
    expect(sent.options.idempotencyKey).toBe(`svc-checkout-pi:${res.body.attemptId}`);
  });

  it("🔴 mints the intent but does NOT mark the cut paid - nobody has tapped yet", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    const res = await tapIntent(id, { amountCents: 4000, requestId: press() });
    expect(res.status).toBe(200);

    const appt = await prisma.appointment.findUnique({
      where: { id },
      select: { paidAt: true, status: true },
    });
    expect(appt?.paidAt).toBeNull();
    // And completion is still the barber's to do, exactly as for a saved card.
    expect(appt?.status).toBe("BOOKED");

    const attempt = await prisma.checkoutAttempt.findFirst({ where: { appointmentId: id } });
    expect(attempt?.method).toBe("tap_to_pay");
    expect(attempt?.state).toBe("processing");
  });

  it("charges only the balance when a deposit was taken", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40, depositCents: 1500 });
    const res = await tapIntent(id, { amountCents: 2500, requestId: press() });
    expect(res.status).toBe(200);
    expect(fake.calls.paymentIntents[0]!.params.amount).toBe(2500);
  });

  it("refuses an amount that is not exactly the balance", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    const high = await tapIntent(id, { amountCents: 6000, requestId: press() });
    expect(high.status).toBe(409);
    expect(high.body.error).toBe("amount_not_authorized");
    expect(high.body.dueCents).toBe(4000);

    const low = await tapIntent(id, { amountCents: 100, requestId: press() });
    expect(low.status).toBe(409);
    expect(low.body.error).toBe("amount_not_authorized");
    // Neither reached Stripe.
    expect(fake.calls.paymentIntents).toHaveLength(0);
  });

  it("🔴 one press is ONE intent, however many times it is sent", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    const requestId = press();
    const first = await tapIntent(id, { amountCents: 4000, requestId });
    const second = await tapIntent(id, { amountCents: 4000, requestId });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.replay).toBe(true);
    expect(second.body.attempt.id).toBe(first.body.attemptId);
    // The resumed press gets the SAME secret back, not a second intent: the app
    // may have been killed between the button and the card.
    expect(second.body.clientSecret).toBe(first.body.clientSecret);
    expect(fake.calls.paymentIntents).toHaveLength(1);
  });

  it("another shop's appointment is not found", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    const res = await tapIntent(id, { amountCents: 4000, requestId: press() }, otherCookie);
    expect(res.status).toBe(404);
    expect(fake.calls.paymentIntents).toHaveLength(0);
  });
});

describe("the window where a card may still be tapped", () => {
  it("🔴 blocks CASH while a contactless collection is open", async () => {
    // This is the whole reason the attempt ledger exists. The barber has handed
    // the phone over; until that intent is concluded, taking cash as well is
    // how one cut gets paid for twice.
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    const open = await tapIntent(id, { amountCents: 4000, requestId: press() });
    expect(open.status).toBe(200);

    const cash = await payCash(id, {
      amountCents: 4000,
      method: "cash",
      requestId: press(),
      confirmed: true,
    });
    expect(cash.status).toBe(409);
    expect(cash.body.error).toBe("collection_in_progress");

    const appt = await prisma.appointment.findUnique({ where: { id }, select: { paidAt: true } });
    expect(appt?.paidAt).toBeNull();
  });

  it("🔴 blocks the SAVED CARD while a contactless collection is open", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40, card: { consent: "single" } });
    const open = await tapIntent(id, { amountCents: 4000, requestId: press() });
    expect(open.status).toBe(200);

    const card = await chargeCard(id, { amountCents: 4000, requestId: press() });
    expect(card.status).toBe(409);
    expect(card.body.error).toBe("collection_in_progress");
  });

  it("🔴 blocks a SECOND tap on the same cut", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    const first = await tapIntent(id, { amountCents: 4000, requestId: press() });
    expect(first.status).toBe(200);

    const second = await tapIntent(id, { amountCents: 4000, requestId: press() });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("collection_in_progress");
    expect(fake.calls.paymentIntents).toHaveLength(1);
  });
});

describe("concluding a tap", () => {
  it("records the money and leaves the cut BOOKED for the barber to finish", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    const open = await tapIntent(id, { amountCents: 4000, requestId: press() });
    fake.tap(open.body.paymentIntentId);

    const settled = await tapSettle(id, { attemptId: open.body.attemptId });
    expect(settled.status).toBe(200);
    expect(settled.body.attempt.state).toBe("succeeded");

    const appt = await prisma.appointment.findUnique({
      where: { id },
      select: { paidAt: true, status: true, paidMethod: true },
    });
    expect(appt?.paidAt).not.toBeNull();
    // 🔴 Taking the money does not finish the cut. Done still does.
    expect(appt?.status).toBe("BOOKED");
  });

  it("🔴 settling twice records the money once", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    const open = await tapIntent(id, { amountCents: 4000, requestId: press() });
    fake.tap(open.body.paymentIntentId);

    await tapSettle(id, { attemptId: open.body.attemptId });
    const again = await tapSettle(id, { attemptId: open.body.attemptId });
    expect(again.status).toBe(200);
    expect(again.body.attempt.state).toBe("succeeded");

    const rows = await prisma.payment.findMany({
      where: { appointmentId: id, purpose: "service_checkout" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("succeeded");
  });

  it("a card declined at the reader leaves the cut unpaid and frees it for cash", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    const open = await tapIntent(id, { amountCents: 4000, requestId: press() });
    fake.tapDeclined(open.body.paymentIntentId);

    const settled = await tapSettle(id, { attemptId: open.body.attemptId });
    expect(settled.status).toBe(200);
    expect(settled.body.attempt.state).toBe("failed");

    const appt = await prisma.appointment.findUnique({ where: { id }, select: { paidAt: true } });
    expect(appt?.paidAt).toBeNull();

    // The lock is released, so the barber can take cash instead.
    const cash = await payCash(id, {
      amountCents: 4000,
      method: "cash",
      requestId: press(),
      confirmed: true,
    });
    expect(cash.status).toBe(200);
  });

  it("🔴 a mint that timed out does NOT strand the barber - and that is safe HERE", async () => {
    // THE ASYMMETRY WORTH UNDERSTANDING BEFORE ANYONE "FIXES" THIS. For a saved
    // card, a create that times out is genuinely ambiguous: it was sent with
    // `confirm: true`, so Stripe may be charging the customer right now, and the
    // attempt must stay live or cash could be taken on top of it.
    //
    // A card-present intent is created UNCONFIRMED and can only be completed by
    // a reader holding its client secret. On this path the secret was never
    // returned to anyone - the request failed - so there is no device that can
    // present a card against it and no way for money to move. Closing the
    // attempt is therefore safe, and leaving it live would strand a barber with
    // a customer in front of them for a charge that cannot happen.
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    fake.setNextCreate("timeout");
    const open = await tapIntent(id, { amountCents: 4000, requestId: press() });
    expect(open.status).toBe(502);
    expect(open.body.clientSecret).toBeUndefined();

    const attempt = await prisma.checkoutAttempt.findFirst({ where: { appointmentId: id } });
    expect(attempt?.state).toBe("failed");

    // There is nothing to ask Stripe about, and the route says so rather than
    // guessing.
    const settled = await tapSettle(id, { attemptId: attempt!.id });
    expect(settled.status).toBe(409);
    expect(settled.body.error).toBe("no_intent_yet");

    const cash = await payCash(id, {
      amountCents: 4000,
      method: "cash",
      requestId: press(),
      confirmed: true,
    });
    expect(cash.status).toBe(200);
  });

  it("will not settle a saved-card attempt through the Tap to Pay route", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40, card: { consent: "single" } });
    const card = await chargeCard(id, { amountCents: 4000, requestId: press() });
    expect(card.status).toBe(200);
    const attempt = await prisma.checkoutAttempt.findFirst({ where: { appointmentId: id } });
    const res = await tapSettle(id, { attemptId: attempt!.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_a_tap_to_pay_attempt");
  });
});

describe("falling back after something went wrong", () => {
  it("🔴 a Stripe refusal closes the attempt so cash still works", async () => {
    const id = await seedAppointment({ shopId, priceDollars: 40 });
    fake.setNextCreate("refuse");
    const res = await tapIntent(id, { amountCents: 4000, requestId: press() });
    expect(res.status).toBe(502);

    const attempt = await prisma.checkoutAttempt.findFirst({ where: { appointmentId: id } });
    expect(attempt?.state).toBe("failed");

    // Stripe said no before any card was presented, so nothing can arrive late
    // and the barber is not stranded.
    const cash = await payCash(id, {
      amountCents: 4000,
      method: "cash",
      requestId: press(),
      confirmed: true,
    });
    expect(cash.status).toBe(200);
  });

  it("🔴 a DECLINED saved card does not block Tap to Pay", async () => {
    // The trap the legacy terminal helper walks into: a declined card leaves a
    // `failed` service_checkout Payment row by design (the row is written
    // before Stripe is called), and refusing on its mere existence would tell
    // the barber the cut was already paid. Falling back to the phone is the
    // entire reason a decline is recoverable.
    const id = await seedAppointment({ shopId, priceDollars: 40, card: { consent: "single" } });
    const declined = await prisma.payment.create({
      data: {
        id: `pay_${randomToken(12)}`,
        shopId,
        appointmentId: id,
        stripePaymentIntentId: `pi_failed_${randomToken(10)}`,
        stripeConnectAccountId: ACCT,
        mode: "card_on_file",
        purpose: "service_checkout",
        amount: 4000,
        currency: "usd",
        status: "failed",
      },
    });
    expect(declined.status).toBe("failed");

    const res = await tapIntent(id, { amountCents: 4000, requestId: press() });
    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toBeTruthy();
  });
});
