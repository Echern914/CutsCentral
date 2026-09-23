import type Stripe from "stripe";
import { runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { stripeClient } from "./stripe.js";
import { stripeErrorFacts } from "./stripeErrors.js";

/**
 * REFUND A POST-SERVICE CHECKOUT PAYMENT, FROM CHAIRBACK.
 *
 * 🔴 WHY THIS EXISTS, AND WHY IT IS NOT "JUST USE STRIPE". A checkout payment
 * (Tap to Pay or a saved card) is a DESTINATION charge: the charge lives on the
 * PLATFORM account and the barber's account receives a transfer of it. The
 * barber's own Stripe dashboard therefore shows only a COPY of the payment, and
 * pressing Refund on that copy reverses the transfer - the barber hands the
 * money back to the platform - while the customer is refunded NOTHING. Stripe
 * then labels the copy "refunded", which is exactly what makes the mistake
 * invisible. It happened on the first live Tap to Pay payment (2026-09-23).
 *
 * So the refund is made here, against the PLATFORM charge, with
 * `reverse_transfer` so the barber's share comes back out of the barber's
 * balance rather than the platform eating it.
 *
 * 🔴 v1 IS A FULL REFUND OF WHAT REMAINS, OR NOTHING - the mirror of checkout,
 * which collects the whole balance or nothing. The manager confirms the exact
 * figure and it must match to the cent. A payment that has ALREADY been partly
 * refunded or partly reversed somewhere else is not guessed at: the answer is
 * "finish this one in Stripe", which is honest, rather than a computed
 * reversal that might take the wrong amount from the wrong account.
 *
 * 🔴 A REFUND DOES NOT REOPEN THE CHECKOUT. `Appointment.paidAt` stays set, so
 * the balance reads zero and no method is offered again. Giving money back is
 * the shop's decision about THIS payment; charging again is a separate one that
 * v1 does not make on the barber's behalf.
 *
 * Nothing customer-sensitive is logged: ids, cents, outcomes.
 */

export type RefundOutcome =
  | {
      outcome: "refunded";
      amountCents: number;
      /** Stripe's own word: card refunds are usually `succeeded` at once. */
      status: "succeeded" | "pending";
      reverseTransfer: boolean;
    }
  /** Stripe already had it fully refunded (e.g. from the platform dashboard). */
  | { outcome: "already_refunded"; refundedCents: number }
  | { outcome: "nothing_to_refund" }
  | { outcome: "amount_changed"; refundableCents: number }
  | { outcome: "not_found" }
  | { outcome: "not_refundable"; reason: "not_collected" | "unconfirmed_charge" }
  | {
      outcome: "refund_in_stripe";
      reason: "partially_refunded" | "transfer_partially_reversed" | "fee_after_reversal";
    }
  | { outcome: "refused"; code: string | null }
  /** We could not tell whether Stripe made it. A retry cannot double it. */
  | { outcome: "unconfirmed" }
  /** Stripe could not be READ, so no refund was attempted at all. */
  | { outcome: "stripe_unavailable" };

const COLLECTED = new Set(["succeeded", "partially_refunded", "refunded"]);

type LedgerOutcome = "succeeded" | "pending" | "failed" | "ambiguous";

async function appendLedger(
  shopId: string,
  row: {
    paymentId: string;
    appointmentId: string;
    actorUserId: string | null;
    amountCents: number;
    reverseTransfer: boolean;
    stripeRefundId: string | null;
    outcome: LedgerOutcome;
    note: string | null;
  },
): Promise<void> {
  // The ledger must never be the reason a refund that DID happen reports as
  // failed. Stripe's refund metadata carries the same actor, so a lost row
  // loses convenience, not the audit.
  try {
    await runWithShop(shopId, (tx) => tx.paymentRefund.create({ data: { shopId, ...row } }));
  } catch (err) {
    logger.error(
      { shopId, paymentId: row.paymentId, outcome: row.outcome, errName: (err as Error)?.name },
      "payment refund ledger write failed",
    );
  }
}

export async function refundServiceCheckoutPayment(input: {
  shopId: string;
  appointmentId: string;
  paymentId: string;
  /** The figure the manager confirmed. Checked, never trusted. */
  confirmedCents: number;
  actorUserId: string | null;
  note: string | null;
}): Promise<RefundOutcome> {
  const { shopId, appointmentId, paymentId } = input;

  // Scoped three ways: this shop, this appointment, and a CHECKOUT payment. A
  // booking deposit is refunded by the cancellation rules, never by this button.
  const payment = await runWithShop(shopId, (tx) =>
    tx.payment.findFirst({
      where: { id: paymentId, appointmentId, shopId, purpose: "service_checkout" },
      select: {
        id: true,
        status: true,
        amount: true,
        capturedAmount: true,
        refundedAmount: true,
        applicationFeeAmount: true,
        stripePaymentIntentId: true,
        stripeChargeId: true,
        ambiguousAt: true,
      },
    }),
  );
  if (!payment) return { outcome: "not_found" };
  if (!COLLECTED.has(payment.status)) return { outcome: "not_refundable", reason: "not_collected" };
  // Whether the CHARGE happened is itself uncertain. Refunding money we are not
  // sure we took is how a customer ends up credited for nothing.
  if (payment.ambiguousAt) return { outcome: "not_refundable", reason: "unconfirmed_charge" };

  const collected = payment.capturedAmount ?? payment.amount;
  const refundable = collected - payment.refundedAmount;
  if (refundable <= 0) return { outcome: "nothing_to_refund" };
  if (payment.refundedAmount > 0) return { outcome: "refund_in_stripe", reason: "partially_refunded" };
  if (input.confirmedCents !== refundable) {
    return { outcome: "amount_changed", refundableCents: refundable };
  }

  const stripe = stripeClient();
  let chargeId = payment.stripeChargeId;
  let charge: Stripe.Charge;
  let transfer: Stripe.Transfer | null;
  // Reads only: if Stripe cannot answer, nothing has been asked of it yet, so
  // "try again" is the whole truth and no ledger row is owed.
  try {
    if (!chargeId) {
      const pi = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
      chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id ?? null;
    }
    if (!chargeId) return { outcome: "not_refundable", reason: "not_collected" };
    charge = await stripe.charges.retrieve(chargeId, { expand: ["transfer"] });
    transfer = await transferOf(stripe, charge);
  } catch (err) {
    logger.warn(
      { shopId, paymentId: payment.id, ...stripeErrorFacts(err) },
      "checkout refund: could not read the charge from Stripe; nothing attempted",
    );
    return { outcome: "stripe_unavailable" };
  }

  // Stripe is the authority on what has already been refunded. A refund made in
  // the PLATFORM dashboard lands here before (or instead of) its webhook, so the
  // ledger is brought forward - monotonically - rather than refunding twice.
  if ((charge.amount_refunded ?? 0) > 0) {
    await runWithShop(shopId, (tx) =>
      tx.payment.updateMany({
        where: { id: payment.id, refundedAmount: { lte: charge.amount_refunded } },
        data: {
          refundedAmount: charge.amount_refunded,
          status: charge.refunded ? "refunded" : "partially_refunded",
        },
      }),
    );
    if (!charge.refunded) return { outcome: "refund_in_stripe", reason: "partially_refunded" };
    // Was it OURS? A press whose answer was lost after Stripe made the refund
    // lands here on the next press. That refund carries our metadata, and it is
    // recorded as the confirmed refund it is - with the actor who made it -
    // rather than filed as "someone else refunded this".
    const ours = await ourEarlierRefund(stripe, charge.id, payment.id);
    if (ours) {
      await appendLedgerOnce(shopId, {
        paymentId: payment.id,
        appointmentId,
        actorUserId: ours.metadata?.actorUserId ?? input.actorUserId,
        amountCents: ours.amount,
        reverseTransfer: Boolean(ours.transfer_reversal),
        stripeRefundId: ours.id,
        outcome: ours.status === "succeeded" ? "succeeded" : "pending",
        note: input.note,
      });
      return {
        outcome: "refunded",
        amountCents: ours.amount,
        status: ours.status === "succeeded" ? "succeeded" : "pending",
        reverseTransfer: Boolean(ours.transfer_reversal),
      };
    }
    return { outcome: "already_refunded", refundedCents: charge.amount_refunded };
  }

  // 🔴 WHOSE BALANCE PAYS FOR THE REFUND. Normally the barber's: their share was
  // transferred, so `reverse_transfer` pulls it back. But if that transfer was
  // ALREADY fully reversed outside ChairBack - precisely what refunding the copy
  // in the barber's dashboard does - the money is back on the platform and a
  // second reversal would fail with nothing left to take. The customer is then
  // refunded from the platform balance that already holds it.
  let reverseTransfer = false;
  if (transfer) {
    if (transfer.amount_reversed === 0) {
      reverseTransfer = true;
    } else if (transfer.amount_reversed >= transfer.amount) {
      // With a platform fee the arithmetic of "who already holds what" is no
      // longer one number; that is Stripe's to settle, not ours to guess.
      if (payment.applicationFeeAmount > 0) {
        return { outcome: "refund_in_stripe", reason: "fee_after_reversal" };
      }
      reverseTransfer = false;
    } else {
      return { outcome: "refund_in_stripe", reason: "transfer_partially_reversed" };
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
        // Our fee comes back too on a normal refund, as the cancellation refund
        // already does. No-op when there is no fee.
        ...(reverseTransfer && payment.applicationFeeAmount > 0 ? { refund_application_fee: true } : {}),
        metadata: {
          source: "chairback_checkout_refund",
          shopId,
          appointmentId,
          paymentId: payment.id,
          ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
        },
      },
      // Derived from the payment and what it had refunded BEFORE this press, so
      // a double tap, a lost response or a retry after "unconfirmed" all name
      // the same refund and Stripe returns it rather than making a second one.
      { idempotencyKey: `svc-refund:${payment.id}:${payment.refundedAmount}` },
    );
  } catch (err) {
    const facts = stripeErrorFacts(err);
    await appendLedger(shopId, {
      ...ledgerBase,
      stripeRefundId: null,
      outcome: facts.definitive ? "failed" : "ambiguous",
    });
    logger.error(
      { shopId, appointmentId, paymentId: payment.id, ...facts },
      facts.definitive ? "checkout refund refused by Stripe" : "checkout refund outcome unknown",
    );
    return facts.definitive ? { outcome: "refused", code: facts.code } : { outcome: "unconfirmed" };
  }

  if (refund.status === "failed" || refund.status === "canceled") {
    await appendLedger(shopId, { ...ledgerBase, stripeRefundId: refund.id, outcome: "failed" });
    logger.warn({ shopId, paymentId: payment.id, status: refund.status }, "checkout refund not made");
    return { outcome: "refused", code: refund.failure_reason ?? null };
  }

  const refundedCents = refund.amount ?? refundable;
  const newRefunded = payment.refundedAmount + refundedCents;
  // Compare-and-set on the figure this refund was computed from. The
  // charge.refunded webhook may already have landed the same total; it is
  // monotonic, so whichever writes second finds the work done.
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
  await appendLedger(shopId, { ...ledgerBase, stripeRefundId: refund.id, outcome: status });
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
    "checkout payment refunded",
  );
  return { outcome: "refunded", amountCents: refundedCents, status, reverseTransfer };
}

/** A refund ChairBack itself made for this payment, identified by our metadata. */
async function ourEarlierRefund(
  stripe: Stripe,
  chargeId: string,
  paymentId: string,
): Promise<Stripe.Refund | null> {
  try {
    const list = await stripe.refunds.list({ charge: chargeId, limit: 10 });
    return (
      list.data.find(
        (r) =>
          r.metadata?.source === "chairback_checkout_refund" &&
          r.metadata?.paymentId === paymentId &&
          r.status !== "failed" &&
          r.status !== "canceled",
      ) ?? null
    );
  } catch {
    // Unable to tell whose refund it was; "already refunded" is still true.
    return null;
  }
}

/** Append a ledger row unless this exact Stripe refund is already recorded. */
async function appendLedgerOnce(
  shopId: string,
  row: Parameters<typeof appendLedger>[1] & { stripeRefundId: string },
): Promise<void> {
  const seen = await runWithShop(shopId, (tx) =>
    tx.paymentRefund.findFirst({
      where: { shopId, stripeRefundId: row.stripeRefundId },
      select: { id: true },
    }),
  ).catch(() => null);
  if (seen) return;
  await appendLedger(shopId, row);
}

async function transferOf(stripe: Stripe, charge: Stripe.Charge): Promise<Stripe.Transfer | null> {
  const t = charge.transfer;
  if (!t) return null;
  if (typeof t === "string") return stripe.transfers.retrieve(t);
  return t;
}
