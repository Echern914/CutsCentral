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
 *   - a reconciler that writes money or status in dry-run: the kill switch is
 *     decoration (it may only write its memory of what it has raised)
 *   - two overlapping runs both adopting: the compare-and-set marker
 *   - one contradiction raised on every pass: ~384 alerts a day (#464)
 */

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("../sentry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sentry.js")>()),
  captureError: sentry.captureError,
}));

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
const { reconcilePayments, reconcileOne, PENDING_GRACE_MS, RECONCILE_ROW_SELECT } = await import("./reconcile.js");
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
const payment = (appointmentId: string) => prisma.payment.findFirst({ where: { appointmentId } });

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

  it("an unpaid tip form is not re-read for its first day - it is unpaid, not unknown - and is after", async () => {
    async function openTip(ageHours: number): Promise<string> {
      const endsAt = new Date(Date.now() - ageHours * 3_600_000 - (seq++ + 1) * 60_000);
      const a = await prisma.appointment.create({
        data: {
          shopId,
          staffId,
          serviceId,
          firstName: "Tip",
          lastName: "Left",
          status: "COMPLETED",
          startsAt: new Date(endsAt.getTime() - 30 * 60_000),
          endsAt,
          priceAtBooking: 40,
          manageToken: randomToken(),
        },
        select: { id: true },
      });
      const intentId = `pi_tip_${randomToken(8)}`;
      const p = await prisma.payment.create({
        data: {
          shopId,
          appointmentId: a.id,
          stripePaymentIntentId: intentId,
          stripeConnectAccountId: "acct_reconcile",
          mode: "ahead",
          purpose: "tip",
          amount: 800,
          applicationFeeAmount: 53,
          status: "requires_payment_method",
        },
        select: { id: true },
      });
      await prisma.$executeRaw`UPDATE "Payment" SET "createdAt" = now() - make_interval(hours => ${ageHours}::int), "updatedAt" = now() - make_interval(hours => ${ageHours}::int) WHERE id = ${p.id}`;
      return intentId;
    }
    const young = await openTip(2);
    const old = await openTip(25);
    retrieve.mockImplementation(async (id: string) => pi({ id, status: "requires_payment_method" }));
    await reconcilePayments({ now: new Date(), dryRun: true });
    const asked = retrieve.mock.calls.map((c) => c[0]);
    expect(asked).not.toContain(young);
    expect(asked).toContain(old);
  });

  it("two overlapping runs racing one reservation adopt it once - the marker is a compare-and-set", async () => {
    const { appointmentId, paymentId } = await ambiguousCharge();
    searchAnswers({ [paymentId]: [pi({ id: "pi_race", status: "succeeded", paymentId })] });
    sentry.captureError.mockClear();
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
    // The loser's snapshot was a replay of the winner's, which is not a dead
    // reservation: it must not raise "a reservation marked dead has an intent".
    const deadAlarms = sentry.captureError.mock.calls.filter(
      (c) =>
        (c[1] as { paymentId?: string } | undefined)?.paymentId === paymentId &&
        String((c[0] as Error).message).includes("reservation marked dead"),
    );
    expect(deadAlarms).toEqual([]);
  });
});

describe("🔴 an escalation is raised once, not every pass (#464)", () => {
  /**
   * Four June rows whose intents Stripe cannot find were raised as an error
   * and a Sentry event on every pass - ~384 a day - burying any real one.
   * These drive reconcileOne on THIS file's rows only (a full pass also scans
   * every other suite's leftovers), read with the reconciler's own select.
   */
  const readRow = (id: string) =>
    prisma.payment.findUniqueOrThrow({ where: { id }, select: RECONCILE_ROW_SELECT });
  const alertsFor = (paymentId: string, what?: string) =>
    sentry.captureError.mock.calls.filter(
      (c) => (c[1] as { paymentId?: string } | undefined)?.paymentId === paymentId &&
        (!what || String((c[0] as Error).message).includes(what)),
    ).length;
  const notFound = () =>
    Object.assign(new Error("No such payment_intent"), {
      type: "StripeInvalidRequestError",
      code: "resource_missing",
      statusCode: 404,
    });

  /** A stale, non-terminal row whose intent Stripe will say does not exist. */
  async function missingIntentRow(over: { status?: string; ambiguous?: boolean } = {}) {
    const { appointmentId } = await savedCard();
    const p = await prisma.payment.create({
      data: {
        shopId,
        appointmentId,
        stripePaymentIntentId: `pi_gone_${randomToken(8)}`,
        stripeConnectAccountId: "acct_reconcile",
        mode: "ahead",
        amount: 4500,
        status: over.status ?? "requires_payment_method",
        ...(over.status === "succeeded" ? { capturedAmount: 4500 } : {}),
        ...(over.ambiguous ? { ambiguousAt: new Date() } : {}),
      },
      select: { id: true, stripePaymentIntentId: true },
    });
    await prisma.$executeRaw`UPDATE "Payment" SET "updatedAt" = now() - interval '2 hours' WHERE id = ${p.id}`;
    return p;
  }

  beforeEach(() => sentry.captureError.mockClear());

  it("🔴 a recorded intent Stripe cannot find is raised ONCE across passes (dry run, production's mode)", async () => {
    const p = await missingIntentRow();
    retrieve.mockRejectedValue(notFound());
    for (let i = 0; i < 3; i++) {
      expect(await reconcileOne(await readRow(p.id), later(), true)).toBe("escalated");
    }
    expect(alertsFor(p.id)).toBe(1);
    expect((await readRow(p.id)).reconcileEscalation).toBe("intent_missing");
  });

  it("remembering it changes nothing else about the row - not even updatedAt", async () => {
    const p = await missingIntentRow();
    retrieve.mockRejectedValue(notFound());
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    await reconcileOne(await readRow(p.id), later(), true);
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    const withoutMemory = (r: object) =>
      Object.fromEntries(
        Object.entries(r).filter(([k]) => k !== "reconcileEscalation" && k !== "reconcileEscalatedVersion"),
      );
    expect(withoutMemory(after)).toEqual(withoutMemory(before));
    expect(after.reconcileEscalatedVersion).toEqual(before.updatedAt);
  });

  it("a DIFFERENT contradiction on the same row is raised again", async () => {
    const p = await missingIntentRow({ status: "succeeded", ambiguous: true });
    retrieve.mockRejectedValueOnce(notFound());
    await reconcileOne(await readRow(p.id), later(), true);
    retrieve.mockResolvedValueOnce(pi({ id: p.stripePaymentIntentId, status: "canceled" }));
    await reconcileOne(await readRow(p.id), later(), true);
    expect(alertsFor(p.id)).toBe(2);
    const row = await readRow(p.id);
    expect(row.reconcileEscalation).toBe("collected_not_collected");
    expect(row.status).toBe("succeeded"); // still left for a person
  });

  it("a clean read forgets it, so when it comes back it is raised again", async () => {
    const p = await missingIntentRow();
    retrieve.mockRejectedValueOnce(notFound());
    await reconcileOne(await readRow(p.id), later(), true);
    retrieve.mockResolvedValueOnce(pi({ id: p.stripePaymentIntentId, status: "requires_payment_method" }));
    expect(await reconcileOne(await readRow(p.id), later(), true)).toBe("unchanged");
    expect((await readRow(p.id)).reconcileEscalation).toBeNull();
    retrieve.mockRejectedValueOnce(notFound());
    await reconcileOne(await readRow(p.id), later(), true);
    expect(alertsFor(p.id)).toBe(2);
  });

  it("any other write to the row since re-arms it", async () => {
    const p = await missingIntentRow();
    retrieve.mockRejectedValue(notFound());
    await reconcileOne(await readRow(p.id), later(), true);
    // A webhook (or a refund, or an ambiguity mark) writes the row through Prisma.
    await prisma.payment.update({ where: { id: p.id }, data: { lastWebhookEventId: `evt_${randomToken(6)}` } });
    await reconcileOne(await readRow(p.id), later(), true);
    expect(alertsFor(p.id)).toBe(2);
  });

  it("Stripe unreachable neither raises nor forgets", async () => {
    const p = await missingIntentRow();
    retrieve.mockRejectedValueOnce(notFound());
    await reconcileOne(await readRow(p.id), later(), true);
    retrieve.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await reconcileOne(await readRow(p.id), later(), true)).toBe("unresolved");
    expect((await readRow(p.id)).reconcileEscalation).toBe("intent_missing");
    retrieve.mockRejectedValueOnce(notFound());
    await reconcileOne(await readRow(p.id), later(), true);
    expect(alertsFor(p.id)).toBe(1);
  });
});
