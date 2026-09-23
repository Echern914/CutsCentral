import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";

/**
 * REFUNDING A CHECKOUT PAYMENT FROM CHAIRBACK, against a FAKE Stripe.
 *
 * 🔴 THE INCIDENT THIS FILE PINS. The first live Tap to Pay payment ($1.00,
 * 2026-09-23) was "refunded" from the barber's own Stripe dashboard. On a
 * destination charge that dashboard shows only a copy; refunding the copy
 * REVERSED THE TRANSFER - the barber gave the dollar back to the platform - and
 * the customer's card was refunded nothing, while Stripe labelled it
 * "refunded". The fake below models exactly that: a charge on the platform, a
 * transfer to the barber, and a refund that either reverses that transfer or
 * does not.
 *
 * What it cannot tell you: whether Stripe's real arithmetic matches this model.
 * The live refund of that $1 is the proof of that, and it is the first thing
 * this button is meant to do.
 */

type FakeTransfer = { id: string; object: "transfer"; amount: number; amount_reversed: number };
type FakeCharge = {
  id: string;
  object: "charge";
  amount: number;
  amount_refunded: number;
  refunded: boolean;
  transfer: FakeTransfer | null;
};

const fake = vi.hoisted(() => {
  const charges = new Map<string, FakeCharge>();
  const refundsByKey = new Map<string, Record<string, unknown>>();
  const calls = {
    refunds: [] as Array<{ params: Record<string, unknown>; options: { idempotencyKey?: string } }>,
  };
  let n = 0;
  let next: "ok" | "refuse" | "timeout" = "ok";
  return {
    charges,
    calls,
    setNext(o: typeof next) {
      next = o;
    },
    reset() {
      calls.refunds.length = 0;
      refundsByKey.clear();
      next = "ok";
    },
    client: {
      accounts: {
        retrieve: vi.fn(async () => ({ charges_enabled: true, payouts_enabled: true, details_submitted: true })),
      },
      paymentIntents: {
        retrieve: vi.fn(async (id: string) => ({ id, status: "succeeded", latest_charge: `ch_${id}` })),
      },
      charges: {
        retrieve: vi.fn(async (id: string) => {
          const c = charges.get(id);
          if (!c) throw Object.assign(new Error("No such charge"), { type: "StripeInvalidRequestError" });
          // A copy, like Stripe: the caller must not be able to mutate state.
          return JSON.parse(JSON.stringify(c));
        }),
      },
      transfers: {
        retrieve: vi.fn(async (id: string) => {
          for (const c of charges.values()) if (c.transfer?.id === id) return { ...c.transfer };
          throw new Error("no such transfer");
        }),
      },
      refunds: {
        list: vi.fn(async (params: { charge: string }) => ({
          data: [...refundsByKey.values()].filter((r) => r.charge === params.charge),
        })),
        create: vi.fn(
          async (params: Record<string, unknown>, options: { idempotencyKey?: string } = {}) => {
            calls.refunds.push({ params, options });
            if (options.idempotencyKey && refundsByKey.has(options.idempotencyKey)) {
              return refundsByKey.get(options.idempotencyKey);
            }
            // One-shot: the scripted failure applies to THIS call only.
            const mode = next;
            next = "ok";
            if (mode === "refuse") {
              throw Object.assign(new Error("Charge already refunded"), {
                type: "StripeInvalidRequestError",
                code: "charge_already_refunded",
              });
            }
            const c = charges.get(params.charge as string);
            if (!c) throw Object.assign(new Error("No such charge"), { type: "StripeInvalidRequestError" });
            const amount = params.amount as number;
            if (c.amount_refunded + amount > c.amount) {
              throw Object.assign(new Error("Refund exceeds charge"), {
                type: "StripeInvalidRequestError",
                code: "amount_too_large",
              });
            }
            // 🔴 Stripe's rule: you cannot reverse a transfer that has nothing
            // left in it. This is what a naive refund of the live $1 would hit.
            if (params.reverse_transfer === true && c.transfer) {
              if (c.transfer.amount_reversed >= c.transfer.amount) {
                throw Object.assign(new Error("Transfer already fully reversed"), {
                  type: "StripeInvalidRequestError",
                  code: "transfer_already_reversed",
                });
              }
              c.transfer.amount_reversed += amount;
            }
            c.amount_refunded += amount;
            c.refunded = c.amount_refunded >= c.amount;
            const refund = {
              id: `re_${++n}`,
              object: "refund",
              amount,
              status: "succeeded",
              charge: c.id,
              metadata: (params.metadata ?? {}) as Record<string, string>,
              transfer_reversal: params.reverse_transfer === true ? `trr_${n}` : null,
            };
            if (options.idempotencyKey) refundsByKey.set(options.idempotencyKey, refund);
            // 🔴 THE DANGEROUS TIMEOUT: Stripe DID refund, and the reply was lost
            // on the way back. Only the idempotency key stands between a retry
            // and a second refund of the same money.
            if (mode === "timeout") throw new Error("socket hang up");
            return refund;
          },
        ),
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
let userId: string;
let otherCookie: string;
let otherShopId: string;
let staffId: string;
let serviceId: string;
const email = `refund-${randomToken(6)}@test.local`.toLowerCase();
const otherEmail = `refund2-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
const ACCT = `acct_test_${randomToken(6)}`;

async function makeShop(ownerEmail: string) {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email: ownerEmail, password, name: "Refunder", smsAttested: true });
  expect(signup.status).toBe(201);
  const c = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", c)
    .send({ name: "Refund Cuts", bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  return { cookie: c, shopId: shop.body.id as string };
}

/**
 * A cut that was PAID through checkout: the appointment is closed (`paidAt`),
 * and a platform charge exists whose transfer to the barber is in the given
 * state. `reversedCents` is how much of that transfer was already pulled back
 * outside ChairBack - the live $1 was fully reversed.
 */
async function seedPaid(opts: {
  shopId?: string;
  cents: number;
  reversedCents?: number;
  alreadyRefundedAtStripe?: number;
  purpose?: string;
  feeCents?: number;
}): Promise<{ apptId: string; paymentId: string; chargeId: string }> {
  const sid = opts.shopId ?? shopId;
  const startsAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const appt = await prisma.appointment.create({
    data: {
      shopId: sid,
      staffId,
      serviceId,
      firstName: "Pat",
      lastName: "Customer",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
      status: "BOOKED",
      manageToken: randomToken(20),
      priceAtBooking: new Prisma.Decimal((opts.cents / 100).toFixed(2)),
      paidAt: new Date(),
    },
  });
  const piId = `pi_${randomToken(10)}`;
  const chargeId = `ch_${randomToken(10)}`;
  const paymentId = `pay_${randomToken(12)}`;
  await prisma.payment.create({
    data: {
      id: paymentId,
      shopId: sid,
      appointmentId: appt.id,
      stripePaymentIntentId: piId,
      stripeChargeId: chargeId,
      stripeConnectAccountId: ACCT,
      mode: "terminal",
      purpose: opts.purpose ?? "service_checkout",
      amount: opts.cents,
      applicationFeeAmount: opts.feeCents ?? 0,
      currency: "usd",
      status: "succeeded",
      capturedAmount: opts.cents,
    },
  });
  const refundedAtStripe = opts.alreadyRefundedAtStripe ?? 0;
  fake.charges.set(chargeId, {
    id: chargeId,
    object: "charge",
    amount: opts.cents,
    amount_refunded: refundedAtStripe,
    refunded: refundedAtStripe >= opts.cents,
    transfer: {
      id: `tr_${randomToken(8)}`,
      object: "transfer",
      amount: opts.cents - (opts.feeCents ?? 0),
      amount_reversed: opts.reversedCents ?? 0,
    },
  });
  return { apptId: appt.id, paymentId, chargeId };
}

const refund = (apptId: string, body: Record<string, unknown>, c = cookie) =>
  request(app).post(`/api/checkout/appointments/${apptId}/refund`).set("Cookie", c).send(body);

const paymentRow = (id: string) =>
  prisma.payment.findUnique({ where: { id }, select: { status: true, refundedAmount: true } });

const ledger = (paymentId: string) =>
  prisma.paymentRefund.findMany({ where: { paymentId }, orderBy: { createdAt: "asc" } });

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  process.env.SERVICE_CHECKOUT_ENABLED = "true";
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();

  const mine = await makeShop(email);
  cookie = mine.cookie;
  shopId = mine.shopId;
  const other = await makeShop(otherEmail);
  otherCookie = other.cookie;
  otherShopId = other.shopId;
  const owner = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  userId = owner!.id;

  // One Stripe account per shop - the column is unique, as it must be.
  for (const [id, acct] of [
    [shopId, ACCT],
    [otherShopId, `acct_test_${randomToken(6)}`],
  ] as const) {
    await prisma.shop.update({
      where: { id },
      data: { stripeConnectAccountId: acct, paymentsMode: "card_on_file", compAccess: true },
    });
  }
  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 40, staffIds: [staffId] });
  serviceId = service.body.id;
});

beforeEach(() => fake.reset());

afterAll(async () => {
  const ids = [shopId, otherShopId].filter(Boolean);
  if (ids.length > 0) await prisma.shop.deleteMany({ where: { id: { in: ids } } });
});

describe("refunding a checkout payment", () => {
  it("🔴 refunds the CUSTOMER on the platform charge and pulls the barber's share back", async () => {
    const { apptId, paymentId, chargeId } = await seedPaid({ cents: 4000 });

    const res = await refund(apptId, { paymentId, amountCents: 4000, note: "Cut was wrong" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, result: "refunded", amountCents: 4000, status: "succeeded" });

    // Asked of Stripe: the PLATFORM charge, the full amount, the transfer reversed.
    expect(fake.calls.refunds).toHaveLength(1);
    const { params, options } = fake.calls.refunds[0]!;
    expect(params).toMatchObject({ charge: chargeId, amount: 4000, reverse_transfer: true });
    expect(options.idempotencyKey).toBe(`svc-refund:${paymentId}:0`);
    expect((params.metadata as Record<string, string>).actorUserId).toBe(userId);

    const c = fake.charges.get(chargeId)!;
    expect(c.amount_refunded).toBe(4000); // the customer got it back
    expect(c.transfer!.amount_reversed).toBe(4000); // out of the barber's share

    expect(await paymentRow(paymentId)).toEqual({ status: "refunded", refundedAmount: 4000 });
    const rows = await ledger(paymentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shopId,
      appointmentId: apptId,
      actorUserId: userId,
      amountCents: 4000,
      reverseTransfer: true,
      outcome: "succeeded",
      note: "Cut was wrong",
    });
    expect(rows[0]!.stripeRefundId).toMatch(/^re_/);
  });

  it("🔴 THE LIVE CASE: a transfer already reversed in the barber's dashboard still refunds the customer", async () => {
    // Exactly the first live payment: $1.00 charged, the barber's copy
    // "refunded" (transfer fully reversed), the customer never refunded.
    const { apptId, paymentId, chargeId } = await seedPaid({ cents: 100, reversedCents: 100 });

    const res = await refund(apptId, { paymentId, amountCents: 100 });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe("refunded");

    // No second reversal - there is nothing left in the transfer to take, and
    // asking for one is what makes Stripe refuse. The platform already holds it.
    expect(fake.calls.refunds[0]!.params).toMatchObject({ charge: chargeId, amount: 100, reverse_transfer: false });
    expect(fake.charges.get(chargeId)!.amount_refunded).toBe(100);
    expect((await ledger(paymentId))[0]).toMatchObject({ reverseTransfer: false, outcome: "succeeded" });
  });

  it("a transfer PARTLY reversed elsewhere is sent to Stripe rather than guessed at", async () => {
    const { apptId, paymentId, chargeId } = await seedPaid({ cents: 4000, reversedCents: 1500 });
    const res = await refund(apptId, { paymentId, amountCents: 4000 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "refund_in_stripe", reason: "transfer_partially_reversed" });
    expect(fake.calls.refunds).toHaveLength(0);
    expect(fake.charges.get(chargeId)!.amount_refunded).toBe(0);
    expect(await ledger(paymentId)).toHaveLength(0);
  });

  it("a fully reversed transfer WITH a platform fee is sent to Stripe too", async () => {
    const { apptId, paymentId } = await seedPaid({ cents: 4000, feeCents: 100, reversedCents: 3900 });
    const res = await refund(apptId, { paymentId, amountCents: 4000 });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("fee_after_reversal");
    expect(fake.calls.refunds).toHaveLength(0);
  });

  it("refunds the platform fee along with a normal refund", async () => {
    const { apptId, paymentId } = await seedPaid({ cents: 4000, feeCents: 100 });
    const res = await refund(apptId, { paymentId, amountCents: 4000 });
    expect(res.status).toBe(200);
    expect(fake.calls.refunds[0]!.params).toMatchObject({ reverse_transfer: true, refund_application_fee: true });
  });

  it("already refunded in the PLATFORM dashboard: says so, catches the ledger up, refunds nothing more", async () => {
    const { apptId, paymentId } = await seedPaid({ cents: 4000, alreadyRefundedAtStripe: 4000 });
    const res = await refund(apptId, { paymentId, amountCents: 4000 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, result: "already_refunded", amountCents: 4000 });
    expect(fake.calls.refunds).toHaveLength(0);
    expect(await paymentRow(paymentId)).toEqual({ status: "refunded", refundedAmount: 4000 });
  });

  it("🔴 a second press refunds nothing more", async () => {
    const { apptId, paymentId, chargeId } = await seedPaid({ cents: 4000 });
    expect((await refund(apptId, { paymentId, amountCents: 4000 })).status).toBe(200);
    const again = await refund(apptId, { paymentId, amountCents: 4000 });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("nothing_to_refund");
    expect(fake.calls.refunds).toHaveLength(1);
    expect(fake.charges.get(chargeId)!.amount_refunded).toBe(4000);
  });

  it("refuses a figure that is not exactly what can be refunded", async () => {
    const { apptId, paymentId } = await seedPaid({ cents: 4000 });
    const res = await refund(apptId, { paymentId, amountCents: 1000 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "amount_changed", refundableCents: 4000 });
    expect(fake.calls.refunds).toHaveLength(0);
  });

  it("a Stripe refusal changes nothing and is written down", async () => {
    const { apptId, paymentId } = await seedPaid({ cents: 4000 });
    fake.setNext("refuse");
    const res = await refund(apptId, { paymentId, amountCents: 4000 });
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("refund_refused");
    expect(await paymentRow(paymentId)).toEqual({ status: "succeeded", refundedAmount: 0 });
    expect((await ledger(paymentId))[0]).toMatchObject({ outcome: "failed", stripeRefundId: null });
  });

  it("🔴 an answer that never arrives: pressing again reuses the SAME refund, never a second", async () => {
    const { apptId, paymentId, chargeId } = await seedPaid({ cents: 4000 });
    fake.setNext("timeout");
    const first = await refund(apptId, { paymentId, amountCents: 4000 });
    expect(first.status).toBe(202);
    expect(first.body.result).toBe("unconfirmed");
    expect(await paymentRow(paymentId)).toEqual({ status: "succeeded", refundedAmount: 0 });

    const second = await refund(apptId, { paymentId, amountCents: 4000 });
    expect(second.status).toBe(200);
    // Same key both times - that is what makes the retry safe.
    const keys = fake.calls.refunds.map((c) => c.options.idempotencyKey);
    expect(new Set(keys).size).toBe(1);
    // The customer was refunded ONCE, although the first answer was lost AFTER
    // Stripe had already made the refund.
    expect(fake.charges.get(chargeId)!.amount_refunded).toBe(4000);
    expect(await paymentRow(paymentId)).toEqual({ status: "refunded", refundedAmount: 4000 });
    expect((await ledger(paymentId)).map((r) => r.outcome)).toEqual(["ambiguous", "succeeded"]);
  });
});

describe("what may be refunded from here", () => {
  it("a booking DEPOSIT is not this button's to refund", async () => {
    const { apptId, paymentId } = await seedPaid({ cents: 1000, purpose: "booking" });
    const res = await refund(apptId, { paymentId, amountCents: 1000 });
    expect(res.status).toBe(404);
    expect(fake.calls.refunds).toHaveLength(0);
  });

  it("another shop's appointment is not found", async () => {
    const { apptId, paymentId } = await seedPaid({ cents: 4000 });
    const res = await refund(apptId, { paymentId, amountCents: 4000 }, otherCookie);
    expect(res.status).toBe(404);
    expect(fake.calls.refunds).toHaveLength(0);
  });

  it("a payment from a DIFFERENT appointment is not found", async () => {
    const a = await seedPaid({ cents: 4000 });
    const b = await seedPaid({ cents: 4000 });
    const res = await refund(a.apptId, { paymentId: b.paymentId, amountCents: 4000 });
    expect(res.status).toBe(404);
    expect(fake.calls.refunds).toHaveLength(0);
  });

  it("the checkout screen lists the payment as refundable, then as refunded", async () => {
    const { apptId, paymentId } = await seedPaid({ cents: 4000 });
    const before = await request(app).get(`/api/checkout/appointments/${apptId}`).set("Cookie", cookie);
    expect(before.status).toBe(200);
    expect(before.body.refunds).toEqual([
      expect.objectContaining({
        paymentId,
        method: "tap_to_pay",
        collectedCents: 4000,
        refundableCents: 4000,
        refundBlocker: null,
      }),
    ]);

    await refund(apptId, { paymentId, amountCents: 4000 });
    const after = await request(app).get(`/api/checkout/appointments/${apptId}`).set("Cookie", cookie);
    expect(after.body.refunds[0]).toMatchObject({ refundableCents: 0, refundedCents: 4000, refundBlocker: "refunded" });
    // A refund does not reopen the checkout: nothing is offered to charge again.
    expect(after.body.remainingCents).toBe(0);
    expect(after.body.methods.tapToPay.available).toBe(false);
  });
});
