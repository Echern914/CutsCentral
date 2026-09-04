import type Stripe from "stripe";
import { apiEnv } from "@chairback/config";
import { prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { captureError } from "../sentry.js";
import { connectEnabled, stripeClient } from "./stripe.js";
import { applyIntentSnapshot, isPendingIntentId } from "./payments.js";
import { stripeErrorFacts } from "./stripeErrors.js";

/**
 * THE PAYMENTS RECONCILER. Every charge path writes its Payment row BEFORE it
 * asks Stripe for anything, and marks the row `ambiguousAt` when Stripe's
 * answer was lost. This is the other half of that contract: a scheduled read
 * of Stripe's own state for every row whose outcome is unknown or stale, and
 * a repair of the LOCAL row to match.
 *
 * 🔴 IT NEVER MOVES MONEY. It never creates an intent, a refund, a credit or
 * a transfer - not even as a "repair". A reservation with nothing behind it at
 * Stripe is marked failed, which is a fact about the past, not an action. A
 * row Stripe disagrees with in a way no rule here can explain (two intents for
 * one reservation, a succeeded row whose intent is canceled) is ESCALATED - a
 * loud log line and a Sentry event with ids only - and left exactly as it is.
 *
 * Three questions, in order, per row:
 *   1. still on its `pending:` reservation id past the grace window? Search
 *      Stripe by our own metadata. One hit: adopt it. None: nothing landed,
 *      mark failed. Several: escalate.
 *   2. marked ambiguous, or non-terminal and stale? Retrieve the intent and
 *      fold its state in through the same guarded write the webhook uses
 *      (a stale answer can never downgrade a collected row).
 *   3. does what Stripe says contradict what we already recorded as final?
 *      Escalate, touch nothing.
 *
 * Safe under overlapping runs: the scheduler lease keeps replicas apart, and
 * every write here is a compare-and-set on the state the row was read in, so a
 * second pass over the same row is a no-op. OFF (the default) means DRY RUN:
 * it reads Stripe, counts what it would do, writes nothing.
 */

export const PAYMENTS_RECONCILE_JOB = "payments-reconcile";
/** A reservation younger than this may still be mid-request. Leave it. */
export const PENDING_GRACE_MS = 10 * 60 * 1000;
/** A non-terminal row untouched for this long has stopped getting webhooks. */
export const STALE_MS = 60 * 60 * 1000;
const BATCH = 50;
const TERMINAL = ["succeeded", "canceled", "failed", "refunded", "partially_refunded"];

export function reconcileEnabled(): boolean {
  return apiEnv().PAYMENTS_RECONCILE_ENABLED;
}

export type RowOutcome =
  | "adopted"
  | "nothing_landed"
  | "repaired"
  | "escalated"
  | "unresolved"
  | "unchanged";

export interface ReconcileResult {
  dryRun: boolean;
  scanned: number;
  adopted: number;
  nothingLanded: number;
  repaired: number;
  escalated: number;
  unresolved: number;
  /** Cents on rows adopted or repaired - amounts only, never who. */
  cents: number;
}

type Row = {
  id: string;
  shopId: string;
  appointmentId: string;
  stripePaymentIntentId: string;
  status: string;
  amount: number;
  mode: string;
  ambiguousAt: Date | null;
};

export async function reconcilePayments(
  opts: { now?: Date; dryRun?: boolean } = {},
): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? !reconcileEnabled();
  const result: ReconcileResult = {
    dryRun,
    scanned: 0,
    adopted: 0,
    nothingLanded: 0,
    repaired: 0,
    escalated: 0,
    unresolved: 0,
    cents: 0,
  };
  if (!connectEnabled()) return result;

  const rows = await prisma.payment.findMany({
    where: {
      OR: [
        // A reservation with no intent id yet - ambiguous or not - waits out
        // the grace window: the request may still be in flight, and Stripe's
        // search index lags the write by up to a minute.
        {
          stripePaymentIntentId: { startsWith: "pending:" },
          createdAt: { lt: new Date(now.getTime() - PENDING_GRACE_MS) },
        },
        // A known intent whose last call was ambiguous (a refund, say) can be
        // read back immediately: retrieve is consistent.
        {
          ambiguousAt: { not: null },
          NOT: { stripePaymentIntentId: { startsWith: "pending:" } },
        },
        {
          status: { notIn: TERMINAL },
          updatedAt: { lt: new Date(now.getTime() - STALE_MS) },
          NOT: { stripePaymentIntentId: { startsWith: "pending:" } },
        },
      ],
    },
    select: {
      id: true,
      shopId: true,
      appointmentId: true,
      stripePaymentIntentId: true,
      status: true,
      amount: true,
      mode: true,
      ambiguousAt: true,
    },
    orderBy: { updatedAt: "asc" },
    take: BATCH,
  });
  result.scanned = rows.length;

  for (const row of rows) {
    // One row's surprise must not end the pass for the others: a thrown
    // error here is that row's problem, counted and logged, and the next row
    // still gets its turn. Nothing has been written for this row on a throw -
    // every write above is the last step of its branch.
    let outcome: RowOutcome;
    try {
      outcome = await reconcileOne(row, now, dryRun);
    } catch (err) {
      logger.error(
        { paymentId: row.id, ...stripeErrorFacts(err), errName: err instanceof Error ? err.name : "unknown" },
        "reconcile: a row threw - left for the next pass",
      );
      outcome = "unresolved";
    }
    if (outcome === "adopted") {
      result.adopted += 1;
      result.cents += row.amount;
    } else if (outcome === "nothing_landed") result.nothingLanded += 1;
    else if (outcome === "repaired") {
      result.repaired += 1;
      result.cents += row.amount;
    } else if (outcome === "escalated") result.escalated += 1;
    else if (outcome === "unresolved") result.unresolved += 1;
  }
  return result;
}

export async function reconcileOne(row: Row, now: Date, dryRun: boolean): Promise<RowOutcome> {
  if (isPendingIntentId(row.stripePaymentIntentId)) {
    // Never re-issue the create from here: FIND what landed, by our metadata.
    let found: Stripe.PaymentIntent[];
    try {
      const r = await stripeClient().paymentIntents.search({
        query: `metadata['paymentId']:'${row.id}'`,
        limit: 3,
      });
      found = r.data;
    } catch (err) {
      logger.warn(
        { paymentId: row.id, ...stripeErrorFacts(err) },
        "reconcile: could not search Stripe for a pending reservation",
      );
      return "unresolved";
    }
    if (found.length > 1) {
      escalate("two or more intents carry one reservation id", { paymentId: row.id, intents: found.length });
      return "escalated";
    }
    if (found.length === 1) {
      const pi = found[0]!;
      if (dryRun) return "adopted";
      await applyIntentSnapshot(pi, `reconcile:${pi.id}:${pi.status}`, { reconciled: true });
      await settleCardOnFile(row, pi);
      logger.warn(
        { paymentId: row.id, intent: pi.id, status: pi.status },
        "reconcile: adopted an intent whose reply never arrived",
      );
      return "adopted";
    }
    // Nothing at Stripe, and the grace window has passed: the request never
    // got there. A fact, recorded as one. The row keeps its reservation id
    // (unique, harmless) so nothing can ever mistake it for a real intent.
    if (dryRun) return "nothing_landed";
    await prisma.payment.updateMany({
      where: { id: row.id, stripePaymentIntentId: row.stripePaymentIntentId },
      data: { status: "failed", ambiguousAt: null, reconciledAt: now },
    });
    if (row.mode === "card_on_file") {
      await runWithShop(row.shopId, (tx) =>
        tx.cardOnFile.updateMany({
          where: { appointmentId: row.appointmentId, status: "charging" },
          data: { status: "failed" },
        }),
      );
    }
    return "nothing_landed";
  }

  // A real intent id: read Stripe's state and fold it in.
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripeClient().paymentIntents.retrieve(row.stripePaymentIntentId);
  } catch (err) {
    const facts = stripeErrorFacts(err);
    if (facts.statusCode === 404) {
      escalate("a recorded intent does not exist at Stripe", { paymentId: row.id });
      return "escalated";
    }
    logger.warn({ paymentId: row.id, ...facts }, "reconcile: could not retrieve an intent");
    return "unresolved";
  }
  // Contradictions between a FINAL local state and Stripe are not repaired
  // by a rule - they are exactly the cases a person has to look at.
  if (
    (row.status === "succeeded" || row.status === "refunded" || row.status === "partially_refunded") &&
    (pi.status === "canceled" || pi.status === "requires_payment_method")
  ) {
    escalate("a collected payment's intent is not collected at Stripe", {
      paymentId: row.id,
      local: row.status,
      stripe: pi.status,
    });
    return "escalated";
  }
  if (dryRun) return pi.status === row.status && !row.ambiguousAt ? "unchanged" : "repaired";
  await applyIntentSnapshot(pi, `reconcile:${pi.id}:${pi.status}`, { reconciled: true });
  if (row.ambiguousAt && pi.status === row.status) {
    // Same status, ambiguity cleared: the marker write above is guarded by the
    // (intent, status) marker, so clear the flag directly if it already ran.
    await prisma.payment.updateMany({
      where: { id: row.id, ambiguousAt: { not: null } },
      data: { ambiguousAt: null, reconciledAt: now },
    });
  }
  await settleCardOnFile(row, pi);
  return pi.status === row.status && !row.ambiguousAt ? "unchanged" : "repaired";
}

/**
 * A card-on-file fee whose outcome was unknown now has one. The row is moved
 * to charged/failed by compare-and-set on `charging`, and the fact that the
 * customer was charged without being told is raised for a person: the
 * settle path's emails are deliberately NOT replayed from here, because a
 * reconciler that sends mail is a reconciler that can send it twice.
 */
async function settleCardOnFile(row: Row, pi: Stripe.PaymentIntent): Promise<void> {
  if (row.mode !== "card_on_file") return;
  const final =
    pi.status === "succeeded" ? "charged" : pi.status === "canceled" || pi.status === "requires_payment_method" ? "failed" : null;
  if (!final) return;
  const { count } = await runWithShop(row.shopId, (tx) =>
    tx.cardOnFile.updateMany({
      where: { appointmentId: row.appointmentId, status: "charging" },
      data: { status: final },
    }),
  );
  if (count > 0 && final === "charged") {
    escalate("a card on file was charged after an ambiguous attempt - the customer has not been told", {
      paymentId: row.id,
      appointmentId: row.appointmentId,
    });
  }
}

function escalate(what: string, ids: Record<string, string | number>): void {
  logger.error({ ...ids, what }, `reconcile: ${what}`);
  captureError(new Error(`payments reconcile: ${what}`), { ...ids, what: "payments_reconcile" });
}
