import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, runWithShop } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { raceBehindRowLock } from "../testing/raceBarrier.js";

/**
 * THE RECONCILER, and the ambiguous card-on-file charge it exists for.
 *
 * What each test would catch if its protection were removed:
 *   - a transport error on the off-session charge recorded as "declined": the
 *     barber is told to collect a fee the customer may already have paid
 *   - a reconciler that re-issues the create instead of searching: a second
 *     charge as a "repair"
 *   - a reconciler that marks a young reservation failed: a request still in
 *     flight declared dead
 *   - a reconciler that writes in dry-run: the kill switch is decoration
 *   - two overlapping runs both adopting: the compare-and-set marker
 */

const create = vi.fn();
const retrieve = vi.fn();
const search = vi.fn();
vi.mock("./stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stripe.js")>();
  return {
    ...actual,
    stripeClient: () => ({ paymentIntents: { create, retrieve, search } }),
  };
});

process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_reconcile";
__resetEnvCacheForTests();

const { chargeCardOnFile } = await import("./cardOnFile.js");
const { reconcilePayments, PENDING_GRACE_MS } = await import("./reconcile.js");
const { pendingIntentId } = await import("./payments.js");

let shopId: string;
let staffId: string;
let serviceId: string;
let userId: string;
let seq = 0;

async function savedCard(): Promise<{ appointmentId: string; cardOnFileId: string }> {
  const startsAt = new Date(Date.now() + (seq++ + 1) * 3_600_000);
  const a = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Card",
      lastName: "Keeper",
      status: "NO_SHOW",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: 40,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  const cof = await runWithShop(shopId, (tx) =>
    tx.cardOnFile.create({
      data: {
        id: `cof_${randomToken(10)}`,
        shopId,
        appointmentId: a.id,
        stripeCustomerId: `cus_${randomToken(8)}`,
        stripeSetupIntentId: `seti_${randomToken(8)}`,
        stripePaymentMethodId: `pm_${randomToken(8)}`,
        status: "saved",
        savedAt: new Date(),
      },
      select: { id: true },
    }),
  );
  return { appointmentId: a.id, cardOnFileId: cof.id };
}

const cofStatus = (appointmentId: string) =>
  runWithShop(shopId, (tx) =>
    tx.cardOnFile.findUnique({ where: { appointmentId }, select: { status: true } }),
  );
const payment = (appointmentId: string) => prisma.payment.findUnique({ where: { appointmentId } });

function pi(over: Partial<{ id: string; status: string; paymentId: string }>) {
  return {
    id: over.id ?? `pi_${randomToken(8)}`,
    status: over.status ?? "succeeded",
    amount_received: over.status === "succeeded" || !over.status ? 2000 : 0,
    latest_charge: "ch_x",
    client_secret: "s",
    metadata: over.paymentId ? { paymentId: over.paymentId } : {},
  };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `reconcile-${randomToken(6)}@test.local`, name: "Reconcile" },
    select: { id: true },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Reconcile Cuts",
      bookingUrl: "https://reconcile.test",
      webhookSecret: randomToken(),
      stripeConnectAccountId: "acct_reconcile",
      platformFeeBps: 0,
    },
    select: { id: true },
  });
  shopId = shop.id;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({ data: { shopId, name: "Cut", durationMin: 30, price: 40 }, select: { id: true } })
  ).id;
});

beforeEach(() => {
  create.mockReset();
  retrieve.mockReset();
  search.mockReset();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

const later = () => new Date(Date.now() + PENDING_GRACE_MS + 60_000);

describe("an off-session charge whose reply was lost", () => {
  it("🔴 is ambiguous, not declined: the card stays charging, the row is marked, nobody is told", async () => {
    const { appointmentId } = await savedCard();
    create.mockRejectedValueOnce(new Error("socket hang up"));
    const out = await chargeCardOnFile({
      shopId,
      appointmentId,
      cents: 2000,
      reason: "no_show",
      description: "No-show fee",
    });
    expect(out.outcome).toBe("ambiguous");
    expect((await cofStatus(appointmentId))?.status).toBe("charging");
    const row = await payment(appointmentId);
    expect(row?.status).not.toBe("failed");
    expect(row?.ambiguousAt).not.toBeNull();
    expect(row?.stripePaymentIntentId).toBe(pendingIntentId(row!.id));
    // And a second attempt cannot charge it again: the CAS holds.
    const again = await chargeCardOnFile({ shopId, appointmentId, cents: 2000, reason: "no_show", description: "x" });
    expect(again.outcome).toBe("already");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("a card decline is still a decline - definitive errors are not ambiguous", async () => {
    const { appointmentId } = await savedCard();
    create.mockRejectedValueOnce(
      Object.assign(new Error("Your card was declined."), { type: "StripeCardError", code: "card_declined", decline_code: "insufficient_funds" }),
    );
    const out = await chargeCardOnFile({ shopId, appointmentId, cents: 2000, reason: "no_show", description: "x" });
    expect(out.outcome).toBe("declined");
    expect((await cofStatus(appointmentId))?.status).toBe("failed");
    const row = await payment(appointmentId);
    expect(row?.status).toBe("failed");
    expect(row?.ambiguousAt).toBeNull();
  });
});

describe("reconcilePayments", () => {
  async function ambiguousCharge(): Promise<{ appointmentId: string; paymentId: string }> {
    const { appointmentId } = await savedCard();
    create.mockRejectedValueOnce(new Error("socket hang up"));
    await chargeCardOnFile({ shopId, appointmentId, cents: 2000, reason: "no_show", description: "x" });
    const row = await payment(appointmentId);
    return { appointmentId, paymentId: row!.id };
  }

  /**
   * The reconciler scans EVERY unresolved row in the database - other tests'
   * leftovers included - so every assertion here is about THIS row, and the
   * Stripe search fake answers only for the reservation it is asked about.
   */
  function searchAnswers(byPaymentId: Record<string, ReturnType<typeof pi>[]>) {
    search.mockImplementation(async (params: { query: string }) => {
      const hit = Object.entries(byPaymentId).find(([id]) => params.query.includes(id));
      return { data: hit ? hit[1] : [] };
    });
  }

  it("🔴 finds the intent Stripe DID make - by our metadata, never by re-issuing the request - and adopts it", async () => {
    const { appointmentId, paymentId } = await ambiguousCharge();
    searchAnswers({ [paymentId]: [pi({ id: "pi_landed", status: "succeeded", paymentId })] });
    const r = await reconcilePayments({ now: later(), dryRun: false });
    expect(r.adopted).toBeGreaterThanOrEqual(1);
    expect(search.mock.calls.some((c) => String(c[0]?.query).includes(paymentId))).toBe(true);
    expect(create).toHaveBeenCalledTimes(1); // the original attempt only
    const row = await payment(appointmentId);
    expect(row?.stripePaymentIntentId).toBe("pi_landed");
    expect(row?.status).toBe("succeeded");
    expect(row?.capturedAmount).toBe(2000);
    expect(row?.ambiguousAt).toBeNull();
    expect(row?.reconciledAt).not.toBeNull();
    expect((await cofStatus(appointmentId))?.status).toBe("charged");
    // A second pass does not touch this row again: it is resolved, so it is
    // not even scanned, and Stripe is not asked about it.
    search.mockClear();
    await reconcilePayments({ now: later(), dryRun: false });
    expect(search.mock.calls.some((c) => String(c[0]?.query).includes(paymentId))).toBe(false);
    expect((await payment(appointmentId))?.stripePaymentIntentId).toBe("pi_landed");
  });

  it("marks a reservation with nothing behind it failed - after the grace window, never before", async () => {
    const { appointmentId, paymentId } = await ambiguousCharge();
    searchAnswers({});
    // Too young: still possibly in flight. Untouched, and not even asked about.
    await reconcilePayments({ now: new Date(), dryRun: false });
    expect(search.mock.calls.some((c) => String(c[0]?.query).includes(paymentId))).toBe(false);
    expect((await payment(appointmentId))?.status).not.toBe("failed");
    // Past the window: a fact, recorded as one - and no create was ever re-issued.
    const old = await reconcilePayments({ now: later(), dryRun: false });
    expect(old.nothingLanded).toBeGreaterThanOrEqual(1);
    const row = await payment(appointmentId);
    expect(row?.status).toBe("failed");
    expect(row?.ambiguousAt).toBeNull();
    expect((await cofStatus(appointmentId))?.status).toBe("failed");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("dry run (the default while the flag is off) reads Stripe and writes nothing", async () => {
    const { appointmentId, paymentId } = await ambiguousCharge();
    searchAnswers({ [paymentId]: [pi({ id: "pi_dry", status: "succeeded", paymentId })] });
    const before = await payment(appointmentId);
    const r = await reconcilePayments({ now: later() }); // dryRun defaults from the flag: off
    expect(r.dryRun).toBe(true);
    expect(r.adopted).toBeGreaterThanOrEqual(1);
    expect(search.mock.calls.some((c) => String(c[0]?.query).includes(paymentId))).toBe(true);
    expect(await payment(appointmentId)).toEqual(before);
    expect((await cofStatus(appointmentId))?.status).toBe("charging");
  });

  it("escalates a contradiction instead of repairing it: a collected row whose intent Stripe says is canceled", async () => {
    const { appointmentId } = await savedCard();
    const p = await prisma.payment.create({
      data: {
        shopId,
        appointmentId,
        stripePaymentIntentId: `pi_${randomToken(8)}`,
        stripeConnectAccountId: "acct_reconcile",
        mode: "card_on_file",
        amount: 2000,
        capturedAmount: 2000,
        status: "succeeded",
        ambiguousAt: new Date(),
      },
    });
    retrieve.mockResolvedValue(pi({ id: p.stripePaymentIntentId, status: "canceled" }));
    const r = await reconcilePayments({ now: later(), dryRun: false });
    expect(r.escalated).toBeGreaterThanOrEqual(1);
    const row = await payment(appointmentId);
    expect(row?.status).toBe("succeeded"); // untouched
    expect(row?.ambiguousAt).not.toBeNull(); // still flagged for a person
  });

  it("two overlapping runs racing one reservation adopt it once - the marker is a compare-and-set", async () => {
    const { appointmentId, paymentId } = await ambiguousCharge();
    searchAnswers({ [paymentId]: [pi({ id: "pi_race", status: "succeeded", paymentId })] });
    const { results, settledEarly } = await raceBehindRowLock("Payment", paymentId, [
      () => reconcilePayments({ now: later(), dryRun: false }),
      () => reconcilePayments({ now: later(), dryRun: false }),
    ]);
    expect(settledEarly).toBe(0);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.map((r) => String(r.reason))).toEqual([]);
    const row = await payment(appointmentId);
    expect(row?.stripePaymentIntentId).toBe("pi_race");
    expect(row?.status).toBe("succeeded");
    expect((await cofStatus(appointmentId))?.status).toBe("charged");
    expect(create).toHaveBeenCalledTimes(1);
  });
});
