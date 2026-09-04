import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { raceBehindRowLock } from "../testing/raceBarrier.js";

/**
 * THE CHARGE PATH'S THREE BAD ENDINGS, and the two guards on refunds.
 *
 * Every test here removes one protection in its head and says what would
 * happen without it:
 *   - no row before the call: a crash between "Stripe accepted" and "row
 *     written" would leave a charge nobody can find
 *   - no idempotency key / a fresh key per attempt: a lost reply retried
 *     would mint a second intent
 *   - "transport error = failed": a lost reply would be recorded as a decline
 *     while the customer was charged
 *   - no boundary validation: a float or a nonsense currency would reach Stripe
 *   - no unique appointmentId: two callers would mint two intents
 *   - no compare-and-set on refundedAmount: two partial refunds computed from
 *     one total would both land
 */

const create = vi.fn();
const retrieve = vi.fn();
const search = vi.fn();
const refundsCreate = vi.fn();
vi.mock("./stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stripe.js")>();
  return {
    ...actual,
    stripeClient: () => ({
      paymentIntents: { create, retrieve, search },
      refunds: { create: refundsCreate },
    }),
  };
});

const { createAheadPaymentIntent, refundForCancellation, validateCharge, pendingIntentId, MAX_CHARGE_CENTS } =
  await import("./payments.js");

let shopId: string;
let staffId: string;
let serviceId: string;
let userId: string;
let seq = 0;

async function appointment(): Promise<string> {
  const startsAt = new Date(Date.now() + (seq++ + 1) * 3_600_000);
  const a = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Pay",
      lastName: "Ahead",
      status: "PENDING",
      holdReason: "payment",
      holdExpiresAt: new Date(Date.now() + 600_000),
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: 60,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return a.id;
}

function transport(message = "socket hang up"): Error {
  return new Error(message); // no `type`: exactly what a lost socket looks like
}
function definitive(type = "StripeInvalidRequestError"): Error {
  return Object.assign(new Error("bad request"), { type });
}
function intent(over: Partial<{ id: string; status: string }> = {}) {
  return {
    id: over.id ?? `pi_${randomToken(8)}`,
    status: over.status ?? "requires_payment_method",
    client_secret: "pi_secret_x",
    amount_received: 0,
    latest_charge: null,
    metadata: {},
  };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `pay-recovery-${randomToken(6)}@test.local`, name: "Recovery" },
    select: { id: true },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: { ownerId: userId, name: "Recovery Cuts", bookingUrl: "https://rec.test", webhookSecret: randomToken() },
    select: { id: true },
  });
  shopId = shop.id;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({ data: { shopId, name: "Cut", durationMin: 30, price: 60 }, select: { id: true } })
  ).id;
});

beforeEach(() => {
  create.mockReset();
  retrieve.mockReset();
  search.mockReset();
  refundsCreate.mockReset();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

const base = (appointmentId: string) => ({
  shopId,
  appointmentId,
  connectAccountId: "acct_recovery",
  amountCents: 6000,
  platformFeeBps: 0,
  description: "Cut at Recovery Cuts",
});

describe("createAheadPaymentIntent: row first, Stripe second", () => {
  it("writes the reservation BEFORE Stripe is asked, then adopts the intent", async () => {
    const appointmentId = await appointment();
    let rowAtCallTime: { stripePaymentIntentId: string; status: string } | null = null;
    create.mockImplementation(async () => {
      rowAtCallTime = await prisma.payment.findUnique({
        where: { appointmentId },
        select: { stripePaymentIntentId: true, status: true },
      });
      return intent({ id: "pi_first" });
    });
    const res = await createAheadPaymentIntent(base(appointmentId));
    expect(res?.clientSecret).toBe("pi_secret_x");
    expect(rowAtCallTime).not.toBeNull();
    expect(rowAtCallTime!.stripePaymentIntentId).toBe(pendingIntentId(res!.paymentId));
    const after = await prisma.payment.findUnique({ where: { appointmentId } });
    expect(after?.stripePaymentIntentId).toBe("pi_first");
    expect(after?.ambiguousAt).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![1]).toEqual({ idempotencyKey: `pi-create:${res!.paymentId}` });
  });

  it("🔴 a lost reply is marked ambiguous, never failed - and the retry re-issues the SAME request under the SAME key", async () => {
    const appointmentId = await appointment();
    create.mockRejectedValueOnce(transport());
    const first = await createAheadPaymentIntent(base(appointmentId));
    expect(first).toBeNull();
    const pending = await prisma.payment.findUnique({ where: { appointmentId } });
    expect(pending).not.toBeNull();
    expect(pending!.stripePaymentIntentId).toBe(pendingIntentId(pending!.id));
    expect(pending!.status).toBe("requires_payment_method"); // NOT "failed"
    expect(pending!.ambiguousAt).not.toBeNull();

    // Stripe had accepted the first request. Its idempotency layer returns the
    // same intent for the same key + params - which is what the retry sends.
    create.mockResolvedValueOnce(intent({ id: "pi_recovered" }));
    const second = await createAheadPaymentIntent({ ...base(appointmentId), amountCents: 9999 /* ignored: the row decides */ });
    expect(second?.paymentId).toBe(pending!.id);
    expect(create).toHaveBeenCalledTimes(2);
    const [firstParams, firstOpts] = create.mock.calls[0]!;
    const [secondParams, secondOpts] = create.mock.calls[1]!;
    expect(secondOpts).toEqual(firstOpts);
    expect(secondParams.amount).toBe(firstParams.amount);
    expect(secondParams.amount).toBe(6000);
    const adopted = await prisma.payment.findUnique({ where: { appointmentId } });
    expect(adopted?.stripePaymentIntentId).toBe("pi_recovered");
    expect(adopted?.ambiguousAt).toBeNull();
  });

  it("a definitive refusal is not ambiguous: the reservation stays, nothing is marked unknown", async () => {
    const appointmentId = await appointment();
    create.mockRejectedValueOnce(definitive());
    expect(await createAheadPaymentIntent(base(appointmentId))).toBeNull();
    const row = await prisma.payment.findUnique({ where: { appointmentId } });
    expect(row?.ambiguousAt).toBeNull();
    expect(row?.stripePaymentIntentId).toBe(pendingIntentId(row!.id));
  });

  it("refuses a float, zero, negative, overflow and an unsupported currency before any row exists", async () => {
    expect(validateCharge(12.5, "usd")).toBe("amount_not_integer");
    expect(validateCharge(0, "usd")).toBe("amount_not_positive");
    expect(validateCharge(-100, "usd")).toBe("amount_not_positive");
    expect(validateCharge(MAX_CHARGE_CENTS + 1, "usd")).toBe("amount_too_large");
    expect(validateCharge(100, "eur")).toBe("unsupported_currency");
    expect(validateCharge(100, "USD")).toBeNull();
    for (const bad of [
      { amountCents: 12.5 },
      { amountCents: 0 },
      { amountCents: -1 },
      { amountCents: MAX_CHARGE_CENTS + 1 },
      { currency: "eur" },
    ]) {
      const appointmentId = await appointment();
      expect(await createAheadPaymentIntent({ ...base(appointmentId), ...bad })).toBeNull();
      expect(await prisma.payment.findUnique({ where: { appointmentId } })).toBeNull();
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("twenty simultaneous requests for one appointment produce at most one Stripe mutation - the unique index refuses a second row", async () => {
    const appointmentId = await appointment();
    create.mockResolvedValue(intent({ id: "pi_only" }));
    retrieve.mockResolvedValue(intent({ id: "pi_only" }));
    // The constraint, head-on: a second Payment for one appointment cannot exist.
    const first = await createAheadPaymentIntent(base(appointmentId));
    expect(first?.paymentId).toBeTruthy();
    await expect(
      prisma.payment.create({
        data: {
          shopId,
          appointmentId,
          stripePaymentIntentId: `pi_${randomToken(6)}`,
          stripeConnectAccountId: "acct_recovery",
          mode: "ahead",
          amount: 6000,
        },
      }),
    ).rejects.toThrow();
    // And twenty more callers, all at once, all handed the one intent.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => createAheadPaymentIntent(base(appointmentId))),
    );
    expect(new Set(results.map((r) => r?.paymentId))).toEqual(new Set([first!.paymentId]));
    expect(create).toHaveBeenCalledTimes(1);
    expect(await prisma.payment.count({ where: { appointmentId } })).toBe(1);
  });
});

describe("refundForCancellation: never more than was collected", () => {
  async function collected(appointmentId: string, cents: number) {
    return prisma.payment.create({
      data: {
        shopId,
        appointmentId,
        stripePaymentIntentId: `pi_${randomToken(8)}`,
        stripeConnectAccountId: "acct_recovery",
        mode: "ahead",
        amount: cents,
        capturedAmount: cents,
        status: "succeeded",
      },
      select: { id: true },
    });
  }

  it("cumulative partial refunds cannot exceed the original payment", async () => {
    const appointmentId = await appointment();
    const p = await collected(appointmentId, 6000);
    refundsCreate.mockImplementation(async (params: { amount: number }) => ({ amount: params.amount }));
    // Keep a $40 fee: $20 back.
    expect(await refundForCancellation({ paymentId: p.id, feeCents: 4000 })).toBe(2000);
    // Then the fee is waived: the REMAINING $40, not another $60.
    expect(await refundForCancellation({ paymentId: p.id, feeCents: 0 })).toBe(4000);
    // Nothing left: no Stripe call at all.
    refundsCreate.mockClear();
    expect(await refundForCancellation({ paymentId: p.id, feeCents: 0 })).toBe(0);
    expect(refundsCreate).not.toHaveBeenCalled();
    const row = await prisma.payment.findUnique({ where: { id: p.id } });
    expect(row?.refundedAmount).toBe(6000);
    expect(row?.status).toBe("refunded");
  });

  it("two partial refunds computed concurrently from one total land once - the compare-and-set on refundedAmount", async () => {
    const appointmentId = await appointment();
    const p = await collected(appointmentId, 6000);
    // Both racers read refundedAmount = 0 and build the same idempotency key,
    // so Stripe would return the same refund to both; the second local write
    // must not land on top of the first.
    refundsCreate.mockResolvedValue({ amount: 2000 });
    const { results, settledEarly } = await raceBehindRowLock("Payment", p.id, [
      () => refundForCancellation({ paymentId: p.id, feeCents: 4000 }),
      () => refundForCancellation({ paymentId: p.id, feeCents: 4000 }),
    ]);
    expect(settledEarly).toBe(0);
    expect(results).toHaveLength(2);
    const keys = refundsCreate.mock.calls.map((c) => c[1]?.idempotencyKey);
    expect(new Set(keys).size).toBe(1);
    const row = await prisma.payment.findUnique({ where: { id: p.id } });
    expect(row?.refundedAmount).toBe(2000);
    expect(row?.status).toBe("partially_refunded");
  });

  it("a lost reply on a refund is marked ambiguous and the next attempt reuses the same key", async () => {
    const appointmentId = await appointment();
    const p = await collected(appointmentId, 6000);
    refundsCreate.mockRejectedValueOnce(transport());
    expect(await refundForCancellation({ paymentId: p.id, feeCents: 0 })).toBe(0);
    let row = await prisma.payment.findUnique({ where: { id: p.id } });
    expect(row?.ambiguousAt).not.toBeNull();
    expect(row?.refundedAmount).toBe(0);
    refundsCreate.mockResolvedValueOnce({ amount: 6000 });
    expect(await refundForCancellation({ paymentId: p.id, feeCents: 0 })).toBe(6000);
    const keys = refundsCreate.mock.calls.map((c) => c[1]?.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    row = await prisma.payment.findUnique({ where: { id: p.id } });
    expect(row?.ambiguousAt).toBeNull();
    expect(row?.status).toBe("refunded");
  });
});
