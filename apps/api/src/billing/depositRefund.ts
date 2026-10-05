import type Stripe from "stripe";
import { runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { stripeCollectedCents } from "../engines/appointmentPayment.js";
import { appendLedger, appendLedgerOnce, ourEarlierRefund, transferOf } from "./refundLedger.js";
import { stripeClient } from "./stripe.js";
import { stripeErrorFacts } from "./stripeErrors.js";

/**
 * GIVE BACK WHAT A CLOSED BOOKING KEPT FROM ITS BOOKING PAYMENT.
 *
 * A deposit (or a full prepayment) is kept, in whole or in part, when a client
 * cancels a non-refundable booking, cancels inside the shop's cutoff, or does
 * not show up. The shop may still want to give it back - a client who was sick,
 * a regular - and before this, nothing in ChairBack could. The shop's own
 * Stripe dashboard cannot do it correctly either: on a destination charge it
 * shows only a COPY, and refunding the copy takes the money back from the shop
 * while the client gets nothing (see billing/serviceRefund.ts for the incident).
 *
 * 🔴 "KEPT" IS NOT STORED ANYWHERE. It is simply what the booking payment still
 * holds - collected minus refunded - on a booking that is CANCELED or NO_SHOW.
 * That one definition covers every way money stays behind: a non-refundable
 * deposit, a late-cancel fee, a no-show, and a cancellation refund that Stripe
 * refused or whose answer was lost. A live booking is refused (its deposit is
 * still going toward the cut), and so is a completed one (it went toward it).
 * Eligibility is decided from AMOUNTS, never from the payment's status word:
 * the reconciler can rewrite `refunded` back to `succeeded` without touching
 * the refunded total.
 *
 * 🔴 HOW THIS DIFFERS FROM THE CHECKOUT REFUND, on purpose:
 *  - An earlier PARTIAL refund is normal here, not a reason to stop. A kept
 *    late-cancel fee is exactly that: the cancellation refunded the rest, with
 *    the shop's share reversed. So what is left is refunded, and the transfer
 *    check asks "does what is left of the shop's share match what is left of
 *    the charge?" rather than "was nothing reversed yet?".
 *  - `ambiguousAt` is not a refusal. On a booking payment it can be left over
 *    from an unclear cancellation refund, and only the reconciler clears it.
 *    Stripe's own charge is read first instead, and it settles the question.
 *    This path never SETS it either.
 *  - Its own idempotency key (`deposit-refund:`) and source tag, so it can
 *    never collide with the cancellation refund's `refund:` key - which, after
 *    a lost answer, would be the same key with a different amount.
 *
 * Nothing customer-sensitive is logged: ids, cents, outcomes.
 */

export type DepositRefundOutcome =
  | {
      outcome: "refunded";
      amountCents: number;
      /** Stripe's own word: card refunds are usually `succeeded` at once. */
      status: "succeeded" | "pending";
      reverseTransfer: boolean;
    }
  /** Everything had already been refunded at Stripe, by someone else. */
  | { outcome: "already_refunded"; refundedCents: number }
  | { outcome: "nothing_to_refund" }
  /** The figure the shop confirmed is no longer what is left. Re-read it. */
  | { outcome: "amount_changed"; refundableCents: number }
  | { outcome: "not_found" }
  | { outcome: "not_refundable"; reason: "booking_open" | "not_collected" }
  /**
   * Stripe's record and ChairBack's disagree in a way no single refund can
   * settle honestly. A person at ChairBack finishes it; the shop's own Stripe
   * dashboard cannot.
   */
  | {
      outcome: "needs_support";
      reason: "transfer_partially_reversed" | "fee_after_reversal" | "refund_not_at_stripe";
    }
  | { outcome: "refused"; code: string | null }
  /** We could not tell whether Stripe made it. A retry cannot double it. */
  | { outcome: "unconfirmed" }
  /** Stripe could not be READ, so no refund was attempted at all. */
  | { outcome: "stripe_unavailable" };

/** The appointment statuses whose booking payment may be given back here. */
export const CLOSED_BOOKING_STATUSES = new Set(["CANCELED", "NO_SHOW"]);

export async function refundKeptDeposit(input: {
  shopId: string;
  appointmentId: string;
  /** The figure the manager confirmed. Checked, never trusted. */
  confirmedCents: number;
  actorUserId: string | null;
  note: string | null;
}): Promise<DepositRefundOutcome> {
  const { shopId, appointmentId } = input;

  // Scoped three ways: this shop, this appointment, and its BOOKING payment
  // (one per appointment - a partial unique index). A checkout payment has its
  // own button.
  const found = await runWithShop(shopId, async (tx) => {
    const appt = await tx.appointment.findFirst({
      where: { id: appointmentId, shopId },
      select: { status: true },
    });
    if (!appt) return null;
    const payment = await tx.payment.findFirst({
      where: { appointmentId, shopId, purpose: "booking" },
      select: {
        id: true,
        status: true,
        amount: true,
        capturedAmount: true,
        refundedAmount: true,
        applicationFeeAmount: true,
        stripePaymentIntentId: true,
        stripeChargeId: true,
      },
    });
    return payment ? { appt, payment } : null;
  });
  if (!found) return { outcome: "not_found" };
  const { appt, payment } = found;
  if (!CLOSED_BOOKING_STATUSES.has(appt.status)) {
    return { outcome: "not_refundable", reason: "booking_open" };
  }

  const collected = payment.capturedAmount ?? payment.amount;
  const refundable = stripeCollectedCents(payment);
  const settle = (stripe: Stripe, charge: Stripe.Charge | null) =>
    settleFromStripe({ shopId, appointmentId, payment, collected, stripe, charge, input });

  if (refundable <= 0) {
    // Never collected (a hold that was released, an intent that was voided) is
    // a different answer from "it was all given back already".
    if (!COLLECTED.has(payment.status)) return { outcome: "not_refundable", reason: "not_collected" };
    // 🔑 A press whose answer was lost, and whose total the charge.refunded
    // webhook then landed, left only an "ambiguous" ledger row. The next press
    // finds nothing left and would end there, so the audit would never say who
    // gave the money back. Settle it from Stripe first - best effort.
    if (await unresolvedPress(shopId, payment.id)) {
      try {
        const stripe = stripeClient();
        const settled = await settle(stripe, await readCharge(stripe, payment));
        if (settled.outcome === "refunded") return settled;
      } catch {
        // Unable to tell; "nothing left to refund" is still true.
      }
    }
    return { outcome: "nothing_to_refund" };
  }
  if (input.confirmedCents !== refundable) {
    return { outcome: "amount_changed", refundableCents: refundable };
  }

  const stripe = stripeClient();
  let charge: Stripe.Charge;
  let transfer: Stripe.Transfer | null;
  // Reads only: if Stripe cannot answer, nothing has been asked of it yet, so
  // "try again" is the whole truth and no ledger row is owed.
  try {
    const read = await readCharge(stripe, payment);
    if (!read) return { outcome: "not_refundable", reason: "not_collected" };
    charge = read;
    transfer = await transferOf(stripe, charge);
  } catch (err) {
    logger.warn(
      { shopId, paymentId: payment.id, ...stripeErrorFacts(err) },
      "deposit refund: could not read the charge from Stripe; nothing attempted",
    );
    return { outcome: "stripe_unavailable" };
  }

  // 🔴 STRIPE IS THE AUTHORITY ON WHAT HAS ALREADY GONE BACK. Three ways it
  // can be ahead of this row: a cancellation refund whose answer was lost, a
  // refund made in the platform dashboard, or OUR OWN earlier press whose
  // answer was lost. The row is brought forward and the shop is shown the
  // true figure rather than refunded against a stale one.
  const stripeRefunded = charge.amount_refunded ?? 0;
  if (stripeRefunded > payment.refundedAmount) return settle(stripe, charge);
  // The row counts more refunded than Stripe shows. The one way that happens
  // is a refund recorded on the way out that Stripe later failed, while the
  // booking still kept something - a failed cancellation refund behind a kept
  // late-cancel fee. Refunding "what is left" would be computed from a wrong
  // figure, so a person settles it. (A failed refund that took the WHOLE
  // remainder leaves the row at fully refunded, and nothing here can see it:
  // no webhook reports a refund that failed after it was made.)
  if (stripeRefunded < payment.refundedAmount) {
    return { outcome: "needs_support", reason: "refund_not_at_stripe" };
  }

  // 🔴 WHOSE BALANCE PAYS FOR THE REFUND. Normally the shop's: its share was
  // transferred, and every earlier refund (the cancellation's) reversed its
  // own part of that share, so what is left of the transfer equals what is
  // left of the charge, and `reverse_transfer` pulls exactly that back. If the
  // transfer was instead ALREADY fully reversed outside ChairBack - what
  // refunding the copy in the shop's own dashboard does - the money is back on
  // the platform, and the client is refunded from there. Anything in between
  // is not a number to guess at.
  let reverseTransfer = false;
  if (transfer) {
    const transferLeft = transfer.amount - transfer.amount_reversed;
    if (transferLeft <= 0) {
      if (payment.applicationFeeAmount > 0) {
        return { outcome: "needs_support", reason: "fee_after_reversal" };
      }
      reverseTransfer = false;
    } else if (transferLeft === refundable) {
      reverseTransfer = true;
    } else {
      return { outcome: "needs_support", reason: "transfer_partially_reversed" };
    }
  }

  const ledgerBase = {
    paymentId: payment.id,
    appointmentId,
    actorUserId: input.actorUserId,
    amountCents: refundable,
    reverseTransfer,
    note: input.note,
  };

  let refund: Stripe.Refund;
  try {
    refund = await stripe.refunds.create(
      {
        charge: charge.id,
        amount: refundable,
        reason: "requested_by_customer",
        ...(transfer ? { reverse_transfer: reverseTransfer } : {}),
        // Our fee comes back too, as the cancellation refund already does.
        // No-op when there is no fee.
        ...(reverseTransfer && payment.applicationFeeAmount > 0 ? { refund_application_fee: true } : {}),
        metadata: {
          source: "chairback_deposit_refund",
          shopId,
          appointmentId,
          paymentId: payment.id,
          ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
        },
      },
      // Derived from the payment and what it had refunded BEFORE this press
      // (already checked equal to Stripe's own figure), so a double tap, a lost
      // response or a retry after "unconfirmed" all name the same refund.
      { idempotencyKey: `deposit-refund:${payment.id}:${payment.refundedAmount}` },
    );
  } catch (err) {
    // 🔴 ANOTHER PRESS GOT THERE FIRST - not "Stripe refused". Two managers
    // pressing at once send the same key with a different actor in the
    // metadata, and a second tap while the first is still in flight sends it
    // while Stripe is busy with it; either way Stripe refuses THIS request
    // while the other one's refund goes through. Re-read and say what
    // actually happened. This press made no refund of its own, so it writes
    // no ledger row.
    if (isIdempotencyConflict(err)) {
      try {
        const fresh = await stripe.charges.retrieve(charge.id);
        if ((fresh.amount_refunded ?? 0) > payment.refundedAmount) return await settle(stripe, fresh);
      } catch {
        // Fall through: we cannot tell yet, and pressing again is safe.
      }
      logger.warn({ shopId, paymentId: payment.id }, "deposit refund: another press holds this refund");
      return { outcome: "unconfirmed" };
    }
    const facts = stripeErrorFacts(err);
    await appendLedger(shopId, {
      ...ledgerBase,
      stripeRefundId: null,
      outcome: facts.definitive ? "failed" : "ambiguous",
    });
    logger.error(
      { shopId, appointmentId, paymentId: payment.id, ...facts },
      facts.definitive ? "deposit refund refused by Stripe" : "deposit refund outcome unknown",
    );
    return facts.definitive ? { outcome: "refused", code: facts.code } : { outcome: "unconfirmed" };
  }

  if (refund.status === "failed" || refund.status === "canceled") {
    await appendLedger(shopId, { ...ledgerBase, stripeRefundId: refund.id, outcome: "failed" });
    logger.warn({ shopId, paymentId: payment.id, status: refund.status }, "deposit refund not made");
    return { outcome: "refused", code: refund.failure_reason ?? null };
  }

  const refundedCents = refund.amount ?? refundable;
  const newRefunded = payment.refundedAmount + refundedCents;
  // Compare-and-set on the figure this refund was computed from. A second
  // press racing this one names the same refund and finds the work done; the
  // charge.refunded webhook is monotonic and converges to the same total.
  await runWithShop(shopId, (tx) =>
    tx.payment.updateMany({
      where: { id: payment.id, refundedAmount: payment.refundedAmount },
      data: {
        refundedAmount: newRefunded,
        status: newRefunded >= collected ? "refunded" : "partially_refunded",
      },
    }),
  );
  const status = refund.status === "succeeded" ? "succeeded" : "pending";
  await appendLedgerOnce(shopId, { ...ledgerBase, stripeRefundId: refund.id, outcome: status });
  logger.info(
    {
      shopId,
      appointmentId,
      paymentId: payment.id,
      amountCents: refundedCents,
      reverseTransfer,
      status,
      actorUserId: input.actorUserId,
    },
    "kept deposit refunded",
  );
  return { outcome: "refunded", amountCents: refundedCents, status, reverseTransfer };
}

const COLLECTED = new Set(["succeeded", "partially_refunded", "refunded"]);

interface BookingPaymentFacts {
  id: string;
  status: string;
  amount: number;
  capturedAmount: number | null;
  refundedAmount: number;
  stripePaymentIntentId: string;
  stripeChargeId: string | null;
}

/** The payment's charge, with its transfer. Null when there is no charge. */
async function readCharge(stripe: Stripe, payment: BookingPaymentFacts): Promise<Stripe.Charge | null> {
  let chargeId = payment.stripeChargeId;
  if (!chargeId) {
    const pi = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
    chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id ?? null;
  }
  if (!chargeId) return null;
  return stripe.charges.retrieve(chargeId, { expand: ["transfer"] });
}

/**
 * Stripe has refunded more than this row knows. Bring the row forward - only
 * ever upward - and say what that means for the shop:
 *  - something is still kept: the figure moved, so the shop re-confirms it;
 *  - everything is back, and the last of it was a refund THIS button made
 *    (found by its source tag): it is recorded, with the manager who made it,
 *    as the refund it is;
 *  - everything is back by someone else's hand: already refunded.
 */
async function settleFromStripe(ctx: {
  shopId: string;
  appointmentId: string;
  payment: BookingPaymentFacts;
  collected: number;
  stripe: Stripe;
  charge: Stripe.Charge | null;
  input: { actorUserId: string | null; note: string | null };
}): Promise<DepositRefundOutcome> {
  const { shopId, appointmentId, payment, collected, stripe, charge } = ctx;
  if (!charge) return { outcome: "nothing_to_refund" };
  const stripeRefunded = charge.amount_refunded ?? 0;
  await runWithShop(shopId, (tx) =>
    tx.payment.updateMany({
      where: { id: payment.id, refundedAmount: { lte: stripeRefunded } },
      data: {
        refundedAmount: stripeRefunded,
        status: stripeRefunded >= collected ? "refunded" : "partially_refunded",
      },
    }),
  );
  if (stripeRefunded < collected) {
    return { outcome: "amount_changed", refundableCents: collected - stripeRefunded };
  }
  const ours = await ourEarlierRefund(stripe, charge.id, payment.id, "chairback_deposit_refund");
  if (ours) {
    const status = ours.status === "succeeded" ? "succeeded" : "pending";
    await appendLedgerOnce(shopId, {
      paymentId: payment.id,
      appointmentId,
      actorUserId: ours.metadata?.actorUserId ?? ctx.input.actorUserId,
      amountCents: ours.amount,
      reverseTransfer: Boolean(ours.transfer_reversal),
      stripeRefundId: ours.id,
      outcome: status,
      note: ctx.input.note,
    });
    return {
      outcome: "refunded",
      amountCents: ours.amount,
      status,
      reverseTransfer: Boolean(ours.transfer_reversal),
    };
  }
  return { outcome: "already_refunded", refundedCents: stripeRefunded };
}

/**
 * A press that left only an "ambiguous" ledger row - Stripe's answer was lost -
 * and no row naming a Stripe refund since. Read only; a failed read is "no".
 */
async function unresolvedPress(shopId: string, paymentId: string): Promise<boolean> {
  return runWithShop(shopId, async (tx) => {
    const lost = await tx.paymentRefund.findFirst({
      where: { shopId, paymentId, outcome: "ambiguous" },
      select: { id: true },
    });
    if (!lost) return false;
    const named = await tx.paymentRefund.findFirst({
      where: { shopId, paymentId, stripeRefundId: { not: null }, outcome: { in: ["succeeded", "pending"] } },
      select: { id: true },
    });
    return !named;
  }).catch(() => false);
}

/**
 * Stripe refusing a request because ANOTHER request with the same key is in
 * flight, or already ran with different parameters. Not an answer about the
 * money: the other request's answer is the one that counts.
 */
function isIdempotencyConflict(err: unknown): boolean {
  const e = (err ?? {}) as { type?: unknown; code?: unknown };
  return e.type === "StripeIdempotencyError" || e.code === "idempotency_key_in_use";
}
