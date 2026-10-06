import type Stripe from "stripe";
import { apiEnv } from "@chairback/config";
import { Prisma, prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { captureError } from "../sentry.js";
import { connectEnabled, stripeClient } from "./stripe.js";
import { applyIntentSnapshot, isPendingIntentId } from "./payments.js";
import { stripeErrorFacts } from "./stripeErrors.js";
import { ABANDONED_TIP_MS, OPEN_TIP_STATUSES } from "./tips.js";

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
 * it reads Stripe, counts what it would do, and writes no money and no status.
 * The one thing it does write, in either mode, is its own memory of which
 * contradictions it has already raised (see escalateOnce).
 *
 * 🔴 AN ESCALATION IS RAISED ONCE, NOT EVERY PASS (#464). A contradiction is
 * left exactly as it is for a person, so the row comes back on every pass -
 * and four June rows whose intents Stripe cannot find were raised as an error
 * and a Sentry event every fifteen minutes, ~384 a day, burying any real one.
 * The three escalations that recur (several intents, intent missing, collected
 * row not collected) now remember what they raised on the row itself:
 * `reconcileEscalation` (which contradiction) and `reconcileEscalatedVersion`
 * (the row's `updatedAt` when it was raised). Raised again only when the
 * contradiction changes, or something else has written the row since. A
 * clean read clears the memory, so a contradiction that comes back is raised
 * again. The other three escalations cannot recur (their row leaves every
 * selection arm) and stay loud every time.
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
  /** Rows in an escalated state this pass - raised now or raised before. */
  escalated: number;
  unresolved: number;
  /** Cents on rows adopted or repaired - amounts only, never who. */
  cents: number;
}

/** The contradictions that recur pass after pass, so are raised once (escalateOnce). */
export type RecurringEscalation = "several_intents" | "intent_missing" | "collected_not_collected";

type Row = {
  id: string;
  shopId: string;
  appointmentId: string;
  stripePaymentIntentId: string;
  status: string;
  amount: number;
  mode: string;
  purpose: string;
  ambiguousAt: Date | null;
  // The alert memory (escalateOnce). Optional so a hand-built row (a test)
  // reads as "never raised" and is raised.
  updatedAt?: Date;
  reconcileEscalation?: string | null;
  reconcileEscalatedVersion?: Date | null;
};

/** What a pass reads per row. Exported for tests that drive reconcileOne directly. */
export const RECONCILE_ROW_SELECT = {
  id: true,
  shopId: true,
  appointmentId: true,
  stripePaymentIntentId: true,
  status: true,
  amount: true,
  mode: true,
  purpose: true,
  ambiguousAt: true,
  updatedAt: true,
  reconcileEscalation: true,
  reconcileEscalatedVersion: true,
} as const;

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
          NOT: [
            { stripePaymentIntentId: { startsWith: "pending:" } },
            // A tip form a client opened and left: nothing is unknown about
            // it, it is simply unpaid, and a day of re-reading it every pass
            // would push rows that ARE unknown out of the batch. The client's
            // own page, the webhook and the abandoned-tip sweep (billing/tips.ts)
            // own it until it is a day old.
            {
              purpose: "tip",
              status: { in: [...OPEN_TIP_STATUSES] },
              createdAt: { gte: new Date(now.getTime() - ABANDONED_TIP_MS) },
            },
          ],
        },
      ],
    },
    select: RECONCILE_ROW_SELECT,
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
  const outcome = await reconcileRow(row, now, dryRun);
  // A clean read: whatever was raised about this row before no longer holds,
  // so forget it - if it comes back, it is raised again. Not on "unresolved"
  // (Stripe could not be read: nothing was learned) or "escalated".
  if (outcome !== "escalated" && outcome !== "unresolved") await forgetEscalation(row);
  return outcome;
}

async function reconcileRow(row: Row, now: Date, dryRun: boolean): Promise<RowOutcome> {
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
      await escalateOnce(row, "several_intents", "two or more intents carry one reservation id", {
        paymentId: row.id,
        intents: found.length,
      });
      return "escalated";
    }
    if (found.length === 1) {
      const pi = found[0]!;
      if (dryRun) return "adopted";
      const adopted = await applyIntentSnapshot(pi, `reconcile:${pi.id}:${pi.status}`, { reconciled: true });
      if (!adopted) {
        // 🔴 AN EARLIER PASS DECLARED THIS RESERVATION DEAD, AND IT WAS NOT.
        // Its search found nothing (Stripe's index can lag) and marked it
        // failed; the intent has now turned up without having succeeded, so
        // the dead row refused the snapshot (a succeeded one would have been
        // written - money that moved always wins). Record the intent id, so
        // the row stops being searched on every pass, and tell a person -
        // rather than reporting "adopted" forever for a write that never
        // happened.
        const { count } = await prisma.payment.updateMany({
          where: { id: row.id, stripePaymentIntentId: row.stripePaymentIntentId },
          data: { stripePaymentIntentId: pi.id, reconciledAt: now },
        });
        // Nothing to record: another pass (or the webhook) already wrote this
        // intent onto the row - its snapshot was the one that landed, and ours
        // was a replay of it. Not a dead reservation, so nothing to raise.
        if (count === 0) return "unchanged";
        escalate("a reservation marked dead has an intent at Stripe", {
          paymentId: row.id,
          local: row.status,
          stripe: pi.status,
        });
        return "escalated";
      }
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
    if (row.purpose === "service_checkout") {
      // The request never reached Stripe, so nothing was ever confirmable: the
      // attempt is definitively dead and must release the live lock, or the
      // barber can never collect this cut by any method again.
      const { settleServiceCheckout } = await import("../services/serviceCheckoutSettlement.js");
      await settleServiceCheckout({
        shopId: row.shopId,
        appointmentId: row.appointmentId,
        outcome: "declined",
        failureReason: "nothing_landed_at_stripe",
        source: "reconciler",
      });
    } else if (row.mode === "card_on_file") {
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
      await escalateOnce(row, "intent_missing", "a recorded intent does not exist at Stripe", { paymentId: row.id });
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
    await escalateOnce(row, "collected_not_collected", "a collected payment's intent is not collected at Stripe", {
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

  // 🔴 A SERVICE CHECKOUT SETTLES THROUGH ITS OWN SHARED PATH, which also moves
  // the CheckoutAttempt and the appointment's paid fields. Repairing only the
  // card here - as this used to - left an adopted ambiguous attempt holding the
  // live lock forever, so the barber could never collect by any method.
  if (row.purpose === "service_checkout") {
    const { settleServiceCheckoutFromReconciler } = await import(
      "../services/serviceCheckoutSettlement.js"
    );
    await settleServiceCheckoutFromReconciler({
      shopId: row.shopId,
      appointmentId: row.appointmentId,
      stripePaymentIntentId: pi.id,
      stripeStatus: pi.status,
    });
    if (pi.status === "succeeded") {
      escalate("a service checkout settled from the reconciler - the barber was never told", {
        paymentId: row.id,
        appointmentId: row.appointmentId,
      });
    }
    return;
  }
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

/**
 * Raise a RECURRING contradiction once per (row, contradiction, row version).
 *
 * Quiet only when this exact contradiction was already raised for this exact
 * version of the row; a different contradiction, or any write to the row
 * since (a webhook, a refund, an ambiguity mark all move `updatedAt`), raises
 * it again.
 *
 * RAISE FIRST, REMEMBER AFTER: a pass that dies between the two raises it
 * again next time - at least once, never not at all. The memory is written
 * with raw SQL so `updatedAt` does not move: the memory is not a change to
 * the payment, and must not look like one to the version check, the stale
 * clock that selects rows, or anything else that reads `updatedAt`.
 */
async function escalateOnce(
  row: Row,
  code: RecurringEscalation,
  what: string,
  ids: Record<string, string | number>,
): Promise<void> {
  const raisedBefore =
    row.reconcileEscalation === code &&
    row.updatedAt !== undefined &&
    row.reconcileEscalatedVersion?.getTime() === row.updatedAt.getTime();
  if (raisedBefore) {
    logger.debug({ ...ids, what }, `reconcile: still unresolved - ${what}`);
    return;
  }
  escalate(what, ids);
  const version = row.updatedAt
    ? Prisma.sql`${row.updatedAt.toISOString()}::timestamp`
    : Prisma.sql`"updatedAt"`;
  try {
    await prisma.$executeRaw`
      UPDATE "Payment"
         SET "reconcileEscalation" = ${code}, "reconcileEscalatedVersion" = ${version}
       WHERE "id" = ${row.id}`;
  } catch (err) {
    logger.warn(
      { paymentId: row.id, errName: err instanceof Error ? err.name : "unknown" },
      "reconcile: could not remember an escalation - it will be raised again next pass",
    );
  }
}

/** Forget what was raised about a row, after a clean read. Never throws. */
async function forgetEscalation(row: Row): Promise<void> {
  if (row.reconcileEscalation === null) return; // known: nothing to forget
  try {
    await prisma.$executeRaw`
      UPDATE "Payment"
         SET "reconcileEscalation" = NULL, "reconcileEscalatedVersion" = NULL
       WHERE "id" = ${row.id} AND "reconcileEscalation" IS NOT NULL`;
  } catch (err) {
    logger.warn(
      { paymentId: row.id, errName: err instanceof Error ? err.name : "unknown" },
      "reconcile: could not clear an escalation",
    );
  }
}
