import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { raceBehindRowLock, winners } from "../testing/raceBarrier.js";

/**
 * REFUND A KEPT DEPOSIT, against a FAKE Stripe.
 *
 * A cancelled or no-show booking can keep what was paid at booking - a
 * non-refundable deposit, a late-cancel fee, a no-show. The shop may give it
 * back. The fake models what matters on a destination charge: the charge on
 * the platform, the transfer of the shop's share, and a refund that either
 * reverses that share or does not. The cancellation's own earlier refund
 * (key `refund:`) is modelled as a charge that is already part refunded with
 * its share reversed, which is what billing/payments.ts leaves behind.
 *
 * What it cannot tell you: whether Stripe's real arithmetic matches it. The
 * transfer of a destination charge is the whole charge amount (an application
 * fee is collected from the shop separately), so a reversing refund takes back
 * exactly its own amount - which is what the fake does.
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
    chargeReads: 0,
  };
  let n = 0;
  let next: "ok" | "refuse" | "timeout" = "ok";
  let readFails = false;
  return {
    charges,
    calls,
    refundsByKey,
    setNext(o: typeof next) {
      next = o;
    },
    failNextRead() {
      readFails = true;
    },
    reset() {
      calls.refunds.length = 0;
      calls.chargeReads = 0;
      refundsByKey.clear();
      next = "ok";
      readFails = false;
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
          calls.chargeReads++;
          if (readFails) {
            readFails = false;
            throw Object.assign(new Error("connection reset"), { type: "StripeConnectionError" });
          }
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
              throw Object.assign(new Error("Your card was declined"), {
                type: "StripeInvalidRequestError",
                code: "charge_disputed",
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
            if (params.reverse_transfer === true && c.transfer) {
              if (c.transfer.amount - c.transfer.amount_reversed < amount) {
                throw Object.assign(new Error("Transfer has too little left to reverse"), {
                  type: "StripeInvalidRequestError",
                  code: "transfer_already_reversed",
                });
              }
              c.transfer.amount_reversed += amount;
            }
            c.amount_refunded += amount;
            c.refunded = c.amount_refunded >= c.amount;
            const refund = {
              id: `re_dep_${++n}_${randomTokenLite()}`,
              object: "refund",
              amount,
              status: "succeeded",
              charge: c.id,
              metadata: (params.metadata ?? {}) as Record<string, string>,
              transfer_reversal: params.reverse_transfer === true ? `trr_${n}` : null,
            };
            if (options.idempotencyKey) refundsByKey.set(options.idempotencyKey, refund);
            // Stripe DID refund, and the reply was lost on the way back.
            if (mode === "timeout") throw new Error("socket hang up");
            return refund;
          },
        ),
      },
    },
  };
  // Refund ids are unique across the whole test database (the ledger's
  // unique index), so a counter alone would collide with a previous run's rows.
  function randomTokenLite() {
    return Math.random().toString(36).slice(2, 10);
  }
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
const email = `deprefund-${randomToken(6)}@test.local`.toLowerCase();
const otherEmail = `deprefund2-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
const ACCT = `acct_test_${randomToken(6)}`;

async function makeShop(ownerEmail: string) {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email: ownerEmail, password, name: "Depositor", smsAttested: true });
  expect(signup.status).toBe(201);
  const c = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", c)
    .send({ name: "Deposit Cuts", bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  return { cookie: c, shopId: shop.body.id as string };
}

/**
 * A booking whose BOOKING payment (a deposit, mode "ahead") was collected, in
 * the state a cancellation or no-show left it.
 *
 * `refunded` is what the cancellation already gave back, as BOTH Stripe and
 * the row record it (a kept late-cancel fee). `stripeAhead` is a refund Stripe
 * made that the row never heard about (a lost answer). `reversedCents`
 * overrides how much of the shop's share has been reversed; by default every
 * earlier refund reversed its own amount, as the cancellation refund does.
 */
async function seedKept(opts: {
  cents: number;
  apptStatus?: "CANCELED" | "NO_SHOW" | "BOOKED" | "COMPLETED";
  paymentStatus?: string;
  refunded?: number;
  stripeAhead?: number;
  reversedCents?: number;
  feeCents?: number;
  nonRefundable?: boolean;
  purpose?: "booking" | "service_checkout";
  ambiguous?: boolean;
  shopId?: string;
}): Promise<{ apptId: string; paymentId: string; chargeId: string }> {
  const sid = opts.shopId ?? shopId;
  const apptStatus = opts.apptStatus ?? "CANCELED";
  const startsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const appt = await prisma.appointment.create({
    data: {
      shopId: sid,
      staffId,
      serviceId,
      firstName: "Pat",
      lastName: "Client",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
      status: apptStatus,
      ...(apptStatus === "CANCELED" ? { canceledAt: new Date() } : {}),
      manageToken: randomToken(20),
      priceAtBooking: new Prisma.Decimal("40.00"),
    },
  });
  const refunded = opts.refunded ?? 0;
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
      mode: "ahead",
      purpose: opts.purpose ?? "booking",
      amount: opts.cents,
      applicationFeeAmount: opts.feeCents ?? 0,
      currency: "usd",
      status:
        opts.paymentStatus ??
        (refunded >= opts.cents ? "refunded" : refunded > 0 ? "partially_refunded" : "succeeded"),
      refundedAmount: refunded,
      nonRefundable: opts.nonRefundable ?? false,
      ...(opts.ambiguous ? { ambiguousAt: new Date() } : {}),
    },
  });
  const atStripe = refunded + (opts.stripeAhead ?? 0);
  fake.charges.set(chargeId, {
    id: chargeId,
    object: "charge",
    amount: opts.cents,
    amount_refunded: atStripe,
    refunded: atStripe >= opts.cents,
    transfer: {
      id: `tr_${randomToken(8)}`,
      object: "transfer",
      amount: opts.cents,
      amount_reversed: opts.reversedCents ?? atStripe,
    },
  });
  return { apptId: appt.id, paymentId, chargeId };
}

const refundDeposit = (apptId: string, body: Record<string, unknown>, c = cookie) =>
  request(app).post(`/api/booking/appointments/${apptId}/deposit-refund`).set("Cookie", c).send(body);

const detail = (apptId: string, c = cookie) =>
  request(app).get(`/api/booking/appointments/${apptId}/detail`).set("Cookie", c);

const paymentRow = (id: string) =>
  prisma.payment.findUnique({
    where: { id },
    select: { status: true, refundedAmount: true, ambiguousAt: true },
  });

const ledger = (paymentId: string) =>
  prisma.paymentRefund.findMany({ where: { paymentId }, orderBy: { createdAt: "asc" } });

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  __resetEnvCacheForTests();
  // Resolved once, before any race: a mock is not shared until the module is.
  await import("../billing/stripe.js");
  await import("../billing/depositRefund.js");
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

  for (const [id, acct] of [
    [shopId, ACCT],
    [otherShopId, `acct_test_${randomToken(6)}`],
  ] as const) {
    await prisma.shop.update({
      where: { id },
      data: {
        stripeConnectAccountId: acct,
        paymentsMode: "deposit",
        depositAmountCents: 1000,
        compAccess: true,
      },
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

describe("what a closed booking kept, offered back", () => {
  it("🔴 a non-refundable deposit a client cancelled goes back to the CLIENT, with the shop's share reversed", async () => {
    const { apptId, paymentId, chargeId } = await seedKept({ cents: 1000, nonRefundable: true });

    const before = await detail(apptId);
    expect(before.status).toBe(200);
    expect(before.body.keptDeposit).toEqual({ amountCents: 1000, nonRefundable: true });

    const res = await refundDeposit(apptId, { amountCents: 1000, note: "  was sick  " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, result: "refunded", amountCents: 1000, status: "succeeded" });

    expect(fake.calls.refunds).toHaveLength(1);
    const call = fake.calls.refunds[0]!;
    expect(call.params).toMatchObject({
      charge: chargeId,
      amount: 1000,
      reverse_transfer: true,
      metadata: { source: "chairback_deposit_refund", paymentId, appointmentId: apptId, actorUserId: userId },
    });
    expect(call.params.refund_application_fee).toBeUndefined();
    // Its OWN key - never the cancellation refund's `refund:` key.
    expect(call.options.idempotencyKey).toBe(`deposit-refund:${paymentId}:0`);
    expect(fake.charges.get(chargeId)!.amount_refunded).toBe(1000);
    expect(fake.charges.get(chargeId)!.transfer!.amount_reversed).toBe(1000);

    expect(await paymentRow(paymentId)).toMatchObject({ status: "refunded", refundedAmount: 1000 });
    const rows = await ledger(paymentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shopId,
      appointmentId: apptId,
      actorUserId: userId,
      amountCents: 1000,
      reverseTransfer: true,
      outcome: "succeeded",
      note: "was sick",
    });
    expect(rows[0]!.stripeRefundId).toMatch(/^re_dep_/);

    // The sheet stops offering it, and says refunded rather than "kept".
    const after = await detail(apptId);
    expect(after.body.keptDeposit).toBeNull();
    expect(after.body.payment.state).toBe("refunded");
  });

  it("a kept late-cancel fee: the cancellation refunded the rest, and the button gives back the fee", async () => {
    // $40 paid, $30 refunded at cancel with the share reversed, $10 kept.
    const { apptId, paymentId, chargeId } = await seedKept({ cents: 4000, refunded: 3000 });

    expect((await detail(apptId)).body.keptDeposit).toEqual({ amountCents: 1000, nonRefundable: false });
    const res = await refundDeposit(apptId, { amountCents: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.amountCents).toBe(1000);

    const call = fake.calls.refunds[0]!;
    expect(call.params).toMatchObject({ amount: 1000, reverse_transfer: true });
    expect(call.options.idempotencyKey).toBe(`deposit-refund:${paymentId}:3000`);
    expect(fake.charges.get(chargeId)!.amount_refunded).toBe(4000);
    expect(await paymentRow(paymentId)).toMatchObject({ status: "refunded", refundedAmount: 4000 });
  });

  it("a no-show's deposit can be given back", async () => {
    const { apptId, paymentId } = await seedKept({ cents: 1000, apptStatus: "NO_SHOW" });
    expect((await detail(apptId)).body.keptDeposit).toEqual({ amountCents: 1000, nonRefundable: false });
    const res = await refundDeposit(apptId, { amountCents: 1000 });
    expect(res.status).toBe(200);
    expect(await paymentRow(paymentId)).toMatchObject({ status: "refunded", refundedAmount: 1000 });
  });

  it("a live or completed booking's deposit is not this button's - nothing is asked of Stripe", async () => {
    for (const apptStatus of ["BOOKED", "COMPLETED"] as const) {
      const { apptId, paymentId } = await seedKept({ cents: 1000, apptStatus });
      expect((await detail(apptId)).body.keptDeposit, apptStatus).toBeNull();
      const res = await refundDeposit(apptId, { amountCents: 1000 });
      expect(res.status, apptStatus).toBe(409);
      expect(res.body, apptStatus).toEqual({ error: "not_refundable", reason: "booking_open" });
      expect(await paymentRow(paymentId)).toMatchObject({ refundedAmount: 0 });
    }
    expect(fake.calls.refunds).toHaveLength(0);
    expect(fake.calls.chargeReads).toBe(0);
  });

  it("the figure must match to the cent; a different one moves nothing", async () => {
    const { apptId, paymentId } = await seedKept({ cents: 1000 });
    const res = await refundDeposit(apptId, { amountCents: 999 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "amount_changed", refundableCents: 1000 });
    expect(fake.calls.refunds).toHaveLength(0);
    expect(await paymentRow(paymentId)).toMatchObject({ refundedAmount: 0 });
  });

  it("🔴 a cancellation refund whose answer was lost: Stripe's figure wins, and the shop confirms the true one", async () => {
    // The row says nothing went back; Stripe made the $30 refund anyway.
    const { apptId, paymentId, chargeId } = await seedKept({ cents: 4000, stripeAhead: 3000, ambiguous: true });
    expect((await detail(apptId)).body.keptDeposit.amountCents).toBe(4000);

    // ambiguousAt does not refuse: Stripe is read and settles it.
    const first = await refundDeposit(apptId, { amountCents: 4000 });
    expect(first.status).toBe(409);
    expect(first.body).toEqual({ error: "amount_changed", refundableCents: 1000 });
    expect(fake.calls.refunds).toHaveLength(0);
    expect(await paymentRow(paymentId)).toMatchObject({ status: "partially_refunded", refundedAmount: 3000 });

    expect((await detail(apptId)).body.keptDeposit.amountCents).toBe(1000);
    const second = await refundDeposit(apptId, { amountCents: 1000 });
    expect(second.status).toBe(200);
    expect(fake.calls.refunds[0]!.options.idempotencyKey).toBe(`deposit-refund:${paymentId}:3000`);
    expect(fake.charges.get(chargeId)!.amount_refunded).toBe(4000);
  });

  it("the shop refunded the COPY in its own Stripe dashboard: the client is refunded from the platform, no second reversal", async () => {
    const { apptId, chargeId } = await seedKept({ cents: 1000, reversedCents: 1000 });
    const res = await refundDeposit(apptId, { amountCents: 1000 });
    expect(res.status).toBe(200);
    expect(fake.calls.refunds[0]!.params.reverse_transfer).toBe(false);
    expect(fake.charges.get(chargeId)!.amount_refunded).toBe(1000);
    const rows = await ledger((await prisma.payment.findFirst({ where: { appointmentId: apptId } }))!.id);
    expect(rows[0]!.reverseTransfer).toBe(false);
  });

  it("a share partly moved back outside ChairBack is not guessed at - support finishes it", async () => {
    const { apptId, paymentId } = await seedKept({ cents: 1000, reversedCents: 400 });
    const res = await refundDeposit(apptId, { amountCents: 1000 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "needs_support", reason: "transfer_partially_reversed" });
    expect(fake.calls.refunds).toHaveLength(0);
    expect(await ledger(paymentId)).toHaveLength(0);
  });

  it("with a platform fee the fee comes back too; after an outside reversal it goes to support", async () => {
    const normal = await seedKept({ cents: 1000, feeCents: 100 });
    expect((await refundDeposit(normal.apptId, { amountCents: 1000 })).status).toBe(200);
    expect(fake.calls.refunds[0]!.params).toMatchObject({ reverse_transfer: true, refund_application_fee: true });

    const reversed = await seedKept({ cents: 1000, feeCents: 100, reversedCents: 1000 });
    const res = await refundDeposit(reversed.apptId, { amountCents: 1000 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "needs_support", reason: "fee_after_reversal" });
    expect(fake.calls.refunds).toHaveLength(1);
  });

  it("the row counts a refund Stripe does not show: support settles it, nothing is refunded", async () => {
    const { apptId, chargeId } = await seedKept({ cents: 4000, refunded: 3000 });
    // A pending refund that later failed at Stripe: the row still counts it.
    const c = fake.charges.get(chargeId)!;
    c.amount_refunded = 0;
    c.refunded = false;
    c.transfer!.amount_reversed = 0;
    const res = await refundDeposit(apptId, { amountCents: 1000 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "needs_support", reason: "refund_not_at_stripe" });
    expect(fake.calls.refunds).toHaveLength(0);
  });
});

describe("every answer says what happened to the money", () => {
  it("🔴 a lost answer, then a second press: ONE refund, recorded as the shop's", async () => {
    const { apptId, paymentId, chargeId } = await seedKept({ cents: 1000 });

    fake.setNext("timeout");
    const first = await refundDeposit(apptId, { amountCents: 1000 });
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ ok: false, result: "unconfirmed" });
    // Never sets ambiguousAt (that flag lets the reconciler rewrite the status).
    expect(await paymentRow(paymentId)).toMatchObject({ refundedAmount: 0, ambiguousAt: null });
    expect((await ledger(paymentId)).map((r) => r.outcome)).toEqual(["ambiguous"]);

    const second = await refundDeposit(apptId, { amountCents: 1000 });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, result: "refunded", amountCents: 1000 });
    expect(fake.charges.get(chargeId)!.amount_refunded).toBe(1000);
    expect(fake.calls.refunds).toHaveLength(1);
    const rows = await ledger(paymentId);
    expect(rows.map((r) => r.outcome)).toEqual(["ambiguous", "succeeded"]);
    expect(rows[1]!.actorUserId).toBe(userId);
    expect(await paymentRow(paymentId)).toMatchObject({ status: "refunded", refundedAmount: 1000 });
  });

  it("Stripe refuses: nothing refunded, a failed ledger row, the money still offered", async () => {
    const { apptId, paymentId } = await seedKept({ cents: 1000 });
    fake.setNext("refuse");
    const res = await refundDeposit(apptId, { amountCents: 1000 });
    expect(res.status).toBe(402);
    expect(res.body).toEqual({ error: "refund_refused", code: "charge_disputed" });
    expect((await ledger(paymentId)).map((r) => r.outcome)).toEqual(["failed"]);
    expect(await paymentRow(paymentId)).toMatchObject({ refundedAmount: 0 });
    expect((await detail(apptId)).body.keptDeposit.amountCents).toBe(1000);
  });

  it("Stripe can't be read: nothing attempted, no ledger row", async () => {
    const { apptId, paymentId } = await seedKept({ cents: 1000 });
    fake.failNextRead();
    const res = await refundDeposit(apptId, { amountCents: 1000 });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "stripe_unavailable" });
    expect(fake.calls.refunds).toHaveLength(0);
    expect(await ledger(paymentId)).toHaveLength(0);
  });

  it("a second press after the money went back finds nothing to refund", async () => {
    const { apptId } = await seedKept({ cents: 1000 });
    expect((await refundDeposit(apptId, { amountCents: 1000 })).status).toBe(200);
    const again = await refundDeposit(apptId, { amountCents: 1000 });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "nothing_to_refund" });
    expect(fake.calls.refunds).toHaveLength(1);
  });

  it("🔴 decided from AMOUNTS: a refunded deposit read back as 'succeeded' offers nothing", async () => {
    // The reconciler can rewrite `refunded` to `succeeded` and leave the total.
    const { apptId } = await seedKept({ cents: 1000, refunded: 1000, paymentStatus: "succeeded" });
    expect((await detail(apptId)).body.keptDeposit).toBeNull();
    const res = await refundDeposit(apptId, { amountCents: 1000 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "nothing_to_refund" });
    expect(fake.calls.chargeReads).toBe(0);
  });

  it("a payment that was never collected has nothing to refund", async () => {
    const { apptId } = await seedKept({ cents: 1000, paymentStatus: "canceled" });
    expect((await detail(apptId)).body.keptDeposit).toBeNull();
    const res = await refundDeposit(apptId, { amountCents: 1000 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "not_refundable", reason: "not_collected" });
  });

  it("refuses a body it does not expect", async () => {
    const { apptId } = await seedKept({ cents: 1000 });
    for (const body of [{}, { amountCents: -5 }, { amountCents: 10.5 }, { amountCents: 1000, paymentId: "x" }]) {
      expect((await refundDeposit(apptId, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await refundDeposit(apptId, { amountCents: 1000, note: "x".repeat(201) })).status).toBe(400);
    expect(fake.calls.refunds).toHaveLength(0);
  });
});

describe("whose money this button may touch", () => {
  it("another shop's booking does not exist from here", async () => {
    const { apptId, paymentId } = await seedKept({ cents: 1000 });
    const res = await refundDeposit(apptId, { amountCents: 1000 }, otherCookie);
    expect(res.status).toBe(404);
    expect((await detail(apptId, otherCookie)).status).toBe(404);
    expect(fake.calls.refunds).toHaveLength(0);
    expect(await paymentRow(paymentId)).toMatchObject({ refundedAmount: 0 });
  });

  it("a checkout payment is not a deposit: this button does not see it", async () => {
    const { apptId, paymentId } = await seedKept({ cents: 1000, purpose: "service_checkout" });
    expect((await detail(apptId)).body.keptDeposit).toBeNull();
    const res = await refundDeposit(apptId, { amountCents: 1000 });
    expect(res.status).toBe(404);
    expect(fake.calls.refunds).toHaveLength(0);
    expect(await paymentRow(paymentId)).toMatchObject({ refundedAmount: 0 });
  });
});

describe("two presses at once", () => {
  it("🔴 a double press from two devices: ONE refund at Stripe, ONE ledger row, both told the truth", async () => {
    const { apptId, paymentId, chargeId } = await seedKept({ cents: 1000 });
    // Both presses read "nothing refunded yet" and queue at their write to the
    // payment row; only then is the row let go.
    const { results, settledEarly } = await raceBehindRowLock("Payment", paymentId, [
      () => refundDeposit(apptId, { amountCents: 1000 }),
      () => refundDeposit(apptId, { amountCents: 1000 }),
    ]);
    expect(settledEarly).toBe(0);
    const answers = winners(results);
    expect(answers).toHaveLength(2);
    for (const a of answers) {
      expect(a.status).toBe(200);
      expect(a.body).toMatchObject({ ok: true, result: "refunded", amountCents: 1000 });
    }
    expect(fake.charges.get(chargeId)!.amount_refunded).toBe(1000);
    expect(fake.refundsByKey.size).toBe(1);
    expect(await paymentRow(paymentId)).toMatchObject({ status: "refunded", refundedAmount: 1000 });
    expect((await ledger(paymentId)).filter((r) => r.outcome === "succeeded")).toHaveLength(1);
  });

  it("the ledger itself refuses a second row for the same Stripe refund", async () => {
    const { apptId, paymentId } = await seedKept({ cents: 1000 });
    const row = {
      shopId,
      paymentId,
      appointmentId: apptId,
      actorUserId: null,
      amountCents: 1000,
      reverseTransfer: true,
      stripeRefundId: `re_once_${randomToken(8)}`,
      outcome: "succeeded",
      note: null,
    };
    await prisma.paymentRefund.create({ data: row });
    await expect(prisma.paymentRefund.create({ data: row })).rejects.toThrow(/Unique constraint/);
    // Rows Stripe never answered for carry no id, and any number may exist.
    await prisma.paymentRefund.create({ data: { ...row, stripeRefundId: null, outcome: "ambiguous" } });
    await prisma.paymentRefund.create({ data: { ...row, stripeRefundId: null, outcome: "failed" } });
    expect(await ledger(paymentId)).toHaveLength(3);
  });
});
