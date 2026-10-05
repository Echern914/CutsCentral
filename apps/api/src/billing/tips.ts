import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { Prisma, prisma } from "@chairback/db";
import { tipAmountAllowed, tipFeeCents } from "@chairback/config/tips";
import { logger } from "../logger.js";
import { CARD_STEP_EXCLUDED_METHODS, refusedExclusions } from "./cardOnFile.js";
import { applyIntentSnapshot, isPendingIntentId, pendingIntentId } from "./payments.js";
import { stripeClient } from "./stripe.js";
import { errorClassification, stripeErrorFacts } from "./stripeErrors.js";

/**
 * A TIP, CHARGED: a PaymentIntent the CLIENT confirms on their appointment
 * page, after the visit. The money goes to the shop's Stripe account; Stripe's
 * fee comes out of the tip (config/tips.ts); ChairBack keeps none of it.
 *
 * The same shape as every customer charge here (billing/payments.ts):
 *  - a DESTINATION charge on the platform, `on_behalf_of` + `transfer_data`
 *    naming the shop's account, with the fee taken back as the application fee;
 *  - ROW FIRST, STRIPE SECOND: the Payment row (purpose `tip`, a `pending:`
 *    intent id) is written before Stripe hears anything, and a retry re-issues
 *    the identical request, rebuilt from the row, under the identical key;
 *  - `metadata.purpose = "tip"`, so nothing on the webhook path can mistake
 *    it for booking money (and the hold promotion reads the row anyway).
 *
 * 🔴 ONE TIP PER VISIT, enforced by the database: a partial unique index
 * allows one live tip row per appointment (migration 20261046000000). A dead
 * attempt (cancelled, or failed to reach Stripe) frees the visit; a paid or
 * refunded tip never does.
 *
 * 🔴 ON-SESSION ONLY. The client presses Pay and confirms in their own browser,
 * where Stripe handles 3-D Secure. Nothing here charges a card by itself, and
 * nothing here is reachable from the dashboard.
 *
 * 🔴 THE SAME METHODS AS THE CARD STEP: card, Apple Pay, Link - never Cash App
 * or pay-later (CARD_STEP_EXCLUDED_METHODS). An ACH tip would sit "processing"
 * for days, and Cash App was where card steps died.
 */

const COLLECTED = new Set(["succeeded", "partially_refunded", "refunded"]);
/** A tip the client can still confirm (or is confirming). */
const OPEN = new Set(["requires_payment_method", "requires_confirmation", "requires_action"]);

export type CreateTipOutcome =
  | { outcome: "ready"; clientSecret: string; amountCents: number }
  | { outcome: "invalid_amount" }
  /** The visit already has a paid (or refunded) tip: one per visit. */
  | { outcome: "already_tipped" }
  /** A tip is mid-payment (3-D Secure, or processing). Let it finish. */
  | { outcome: "in_progress" }
  /** Stripe refused to create the intent. Nothing exists to pay. */
  | { outcome: "refused"; code: string | null }
  /** We could not tell whether Stripe made it. Trying again is safe. */
  | { outcome: "unconfirmed" }
  | { outcome: "unavailable" };

type TipRow = {
  id: string;
  status: string;
  amount: number;
  applicationFeeAmount: number;
  stripePaymentIntentId: string;
  stripeConnectAccountId: string;
};

const TIP_ROW_SELECT = {
  id: true,
  status: true,
  amount: true,
  applicationFeeAmount: true,
  stripePaymentIntentId: true,
  stripeConnectAccountId: true,
} as const;

async function liveTip(appointmentId: string): Promise<TipRow | null> {
  return prisma.payment.findFirst({
    where: { appointmentId, purpose: "tip", status: { notIn: ["failed", "canceled"] } },
    select: TIP_ROW_SELECT,
  });
}

/**
 * Get the client a tip they can pay: a fresh intent for `amountCents`, or the
 * open one they already started for the same amount.
 */
export async function createTipIntent(input: {
  shopId: string;
  appointmentId: string;
  connectAccountId: string;
  amountCents: number;
  /** "<service> - tip", the line the shop sees in Stripe. */
  description: string;
}): Promise<CreateTipOutcome> {
  if (!tipAmountAllowed(input.amountCents)) return { outcome: "invalid_amount" };
  try {
    // Twice at most: a second client tab can reserve between our read and our
    // insert, and the unique index then tells us to read again.
    for (let attempt = 0; attempt < 2; attempt++) {
      const live = await liveTip(input.appointmentId);
      if (live) {
        if (COLLECTED.has(live.status)) return { outcome: "already_tipped" };
        if (!OPEN.has(live.status)) return { outcome: "in_progress" };
        if (live.amount === input.amountCents) return await resume(input, live);
        // A different amount on an attempt the client is part-way through
        // confirming (a 3-D Secure screen): let it finish rather than pull it
        // from under them.
        if (live.status !== "requires_payment_method") return { outcome: "in_progress" };
        // The client changed their mind before paying (15% -> 20%): retire
        // that attempt, then make the one they chose.
        if (!(await retire(input, live))) return { outcome: "in_progress" };
        continue;
      }
      const paymentId = `pay_${cryptoId()}`;
      try {
        await prisma.payment.create({
          data: {
            id: paymentId,
            shopId: input.shopId,
            appointmentId: input.appointmentId,
            stripePaymentIntentId: pendingIntentId(paymentId),
            stripeConnectAccountId: input.connectAccountId,
            mode: "ahead",
            purpose: "tip",
            amount: input.amountCents,
            currency: "usd",
            applicationFeeAmount: tipFeeCents(input.amountCents),
            status: "requires_payment_method",
          },
        });
      } catch (err) {
        // Another tab reserved this visit's tip first: read theirs instead.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
        throw err;
      }
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: TIP_ROW_SELECT });
      return await issue(input, row);
    }
    return { outcome: "in_progress" };
  } catch (err) {
    logger.error(
      { appointmentId: input.appointmentId, errName: errorClassification(err) },
      "tip: could not start the payment",
    );
    return { outcome: "unavailable" };
  }
}

/** The client's own open attempt, for the same amount: hand it back. */
async function resume(
  input: { shopId: string; appointmentId: string; description: string },
  row: TipRow,
): Promise<CreateTipOutcome> {
  // Never got an answer from Stripe: re-issue the identical request, which
  // returns the intent if it was made.
  if (isPendingIntentId(row.stripePaymentIntentId)) return issue(input, row);
  const pi = await stripeClient().paymentIntents.retrieve(row.stripePaymentIntentId);
  if (pi.status === "succeeded" || pi.status === "processing") {
    await applyIntentSnapshot(pi, `tip-resume:${pi.id}:${pi.status}`);
    return pi.status === "succeeded" ? { outcome: "already_tipped" } : { outcome: "in_progress" };
  }
  if (!pi.client_secret || pi.status === "canceled") return { outcome: "unavailable" };
  return { outcome: "ready", clientSecret: pi.client_secret, amountCents: row.amount };
}

/**
 * Retire an unpaid attempt so a different amount can be made. True when it is
 * cancelled at Stripe (or never reached it) and marked dead here; false when
 * it turned out to be paid or paying, which the caller reports as such.
 */
async function retire(
  input: { shopId: string; appointmentId: string; description: string },
  row: TipRow,
): Promise<boolean> {
  let intentId = row.stripePaymentIntentId;
  if (isPendingIntentId(intentId)) {
    // Find out whether it reached Stripe: the identical request returns it.
    const issued = await issue(input, row);
    // Refused outright: nothing exists to pay, and the row is already dead.
    if (issued.outcome === "refused") return true;
    if (issued.outcome !== "ready") return false;
    const fresh = await prisma.payment.findUniqueOrThrow({
      where: { id: row.id },
      select: { stripePaymentIntentId: true },
    });
    intentId = fresh.stripePaymentIntentId;
    if (isPendingIntentId(intentId)) return false;
  }
  try {
    await stripeClient().paymentIntents.cancel(
      intentId,
      { cancellation_reason: "abandoned" },
      { idempotencyKey: `tip-cancel:${row.id}` },
    );
  } catch (err) {
    // Refused because it is no longer cancellable - paid, or paying. Record
    // the truth and leave it alone.
    logger.warn({ paymentId: row.id, ...stripeErrorFacts(err) }, "tip: an earlier attempt could not be cancelled");
    try {
      const pi = await stripeClient().paymentIntents.retrieve(intentId);
      await applyIntentSnapshot(pi, `tip-retire:${pi.id}:${pi.status}`);
    } catch {
      // Unable to tell; the attempt stays as it is and nothing new is made.
    }
    return false;
  }
  const { count } = await prisma.payment.updateMany({
    where: { id: row.id, status: { in: [...OPEN] } },
    data: { status: "canceled" },
  });
  return count === 1;
}

/** Ask Stripe for the intent this row describes. Rebuilt from the ROW, always. */
async function issue(
  input: { shopId: string; appointmentId: string; description: string },
  row: TipRow,
): Promise<CreateTipOutcome> {
  const params: Stripe.PaymentIntentCreateParams = {
    amount: row.amount,
    currency: "usd",
    on_behalf_of: row.stripeConnectAccountId,
    transfer_data: { destination: row.stripeConnectAccountId },
    // Stripe's fee, taken back so it comes out of the tip (config/tips.ts).
    application_fee_amount: row.applicationFeeAmount,
    capture_method: "automatic",
    automatic_payment_methods: { enabled: true }, // card + Apple Pay + Link
    description: input.description,
    metadata: {
      shopId: input.shopId,
      appointmentId: input.appointmentId,
      paymentId: row.id,
      purpose: "tip",
    },
  };
  let intent: Stripe.PaymentIntent;
  try {
    try {
      intent = await stripeClient().paymentIntents.create(
        {
          ...params,
          excluded_payment_method_types: [
            ...CARD_STEP_EXCLUDED_METHODS,
          ] as Stripe.PaymentIntentCreateParams.ExcludedPaymentMethodType[],
        },
        { idempotencyKey: `tip-pi:${row.id}` },
      );
    } catch (err) {
      // Stripe refused the exclusion list itself: offer every method rather
      // than no way to tip - under its own key, since the request differs.
      if (!refusedExclusions(err)) throw err;
      logger.error(
        { paymentId: row.id, ...stripeErrorFacts(err) },
        "tip: Stripe refused the method exclusions - offering every method",
      );
      intent = await stripeClient().paymentIntents.create(params, {
        idempotencyKey: `tip-pi:${row.id}:all-methods`,
      });
    }
  } catch (err) {
    const facts = stripeErrorFacts(err);
    if (facts.definitive) {
      // Nothing was created, so there is nothing anyone can pay: the attempt
      // is dead and frees the visit for a fresh one.
      await prisma.payment.updateMany({
        where: { id: row.id, stripePaymentIntentId: row.stripePaymentIntentId },
        data: { status: "failed" },
      });
    } else {
      await prisma.payment.updateMany({ where: { id: row.id }, data: { ambiguousAt: new Date() } });
    }
    logger.error(
      { appointmentId: input.appointmentId, paymentId: row.id, ...facts },
      facts.definitive ? "tip: Stripe refused to create the payment" : "tip: create outcome unknown",
    );
    return facts.definitive ? { outcome: "refused", code: facts.code } : { outcome: "unconfirmed" };
  }
  // Only the row still on its reservation id adopts: a webhook may have got
  // there first, and its answer stands.
  await prisma.payment.updateMany({
    where: { id: row.id, stripePaymentIntentId: row.stripePaymentIntentId },
    data: { stripePaymentIntentId: intent.id, status: intent.status, ambiguousAt: null },
  });
  if (!intent.client_secret) return { outcome: "unavailable" };
  return { outcome: "ready", clientSecret: intent.client_secret, amountCents: row.amount };
}

/**
 * Ask Stripe where the visit's tip stands and record it - what the page polls
 * after the client pays, so "thank you" never waits on a webhook. Best effort:
 * on any error the row is left as it was.
 */
export async function refreshTipFromStripe(appointmentId: string): Promise<void> {
  const row = await liveTip(appointmentId);
  if (!row || (!OPEN.has(row.status) && row.status !== "processing")) return;
  if (isPendingIntentId(row.stripePaymentIntentId)) return;
  try {
    const pi = await stripeClient().paymentIntents.retrieve(row.stripePaymentIntentId);
    await applyIntentSnapshot(pi, `tip-status:${pi.id}:${pi.status}`);
  } catch (err) {
    logger.warn({ paymentId: row.id, ...stripeErrorFacts(err) }, "tip: could not read the payment from Stripe");
  }
}

/** An unpaid tip attempt this old is let go. */
export const ABANDONED_TIP_MS = 24 * 60 * 60 * 1000;

/**
 * Cancel tip attempts nobody finished. A client who opened the payment form
 * and walked away leaves an intent that could be confirmed forever, and the
 * reconciler would re-read it on every pass. Cancelled at Stripe first; only
 * a cancellation Stripe accepted marks the row dead. Rides the payment-hold
 * sweep's existing job (scheduler.ts).
 */
export async function sweepAbandonedTipIntents(now: Date = new Date()): Promise<number> {
  const rows = await prisma.payment.findMany({
    where: {
      purpose: "tip",
      status: { in: [...OPEN] },
      createdAt: { lt: new Date(now.getTime() - ABANDONED_TIP_MS) },
      NOT: { stripePaymentIntentId: { startsWith: "pending:" } },
    },
    select: { id: true, stripePaymentIntentId: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  let swept = 0;
  for (const row of rows) {
    try {
      await stripeClient().paymentIntents.cancel(
        row.stripePaymentIntentId,
        { cancellation_reason: "abandoned" },
        { idempotencyKey: `tip-cancel:${row.id}` },
      );
      const { count } = await prisma.payment.updateMany({
        where: { id: row.id, status: { in: [...OPEN] } },
        data: { status: "canceled" },
      });
      swept += count;
    } catch (err) {
      // Not cancellable any more (paid, or paying): the webhook or the
      // reconciler records what it became.
      logger.warn({ paymentId: row.id, ...stripeErrorFacts(err) }, "tip sweep: could not cancel an attempt");
    }
  }
  return swept;
}

function cryptoId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 24);
}
