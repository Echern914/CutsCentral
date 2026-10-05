import type Stripe from "stripe";
import { runWithShop } from "@chairback/db";
import { logger } from "../logger.js";

/**
 * WHAT EVERY REFUND A SHOP MAKES FROM CHAIRBACK SHARES: the PaymentRefund
 * ledger (who gave this customer their money back, and why), and the two
 * Stripe reads a refund decision rests on.
 *
 * Two buttons write here - the checkout refund (billing/serviceRefund.ts) and
 * the kept-deposit refund (billing/depositRefund.ts). They differ in WHICH
 * payment they may touch and in what an earlier partial refund means; they do
 * not differ in how the audit is kept.
 */

export type LedgerOutcome = "succeeded" | "pending" | "failed" | "ambiguous";

export interface LedgerRow {
  paymentId: string;
  appointmentId: string;
  actorUserId: string | null;
  amountCents: number;
  reverseTransfer: boolean;
  stripeRefundId: string | null;
  outcome: LedgerOutcome;
  note: string | null;
}

export async function appendLedger(shopId: string, row: LedgerRow): Promise<void> {
  // The ledger must never be the reason a refund that DID happen reports as
  // failed. Stripe's refund metadata carries the same actor, so a lost row
  // loses convenience, not the audit.
  try {
    await runWithShop(shopId, (tx) => tx.paymentRefund.create({ data: { shopId, ...row } }));
  } catch (err) {
    // One row per Stripe refund (a unique index): a second press that named
    // the same refund finds it recorded already, which is the outcome wanted.
    if ((err as { code?: string })?.code === "P2002" && row.stripeRefundId) return;
    logger.error(
      { shopId, paymentId: row.paymentId, outcome: row.outcome, errName: (err as Error)?.name },
      "payment refund ledger write failed",
    );
  }
}

/** Append a ledger row unless this exact Stripe refund is already recorded. */
export async function appendLedgerOnce(
  shopId: string,
  row: LedgerRow & { stripeRefundId: string },
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

/**
 * A refund ChairBack itself made for this payment, identified by the
 * `source` tag that refund was created with.
 */
export async function ourEarlierRefund(
  stripe: Stripe,
  chargeId: string,
  paymentId: string,
  source: "chairback_checkout_refund" | "chairback_deposit_refund" | "chairback_tip_refund",
): Promise<Stripe.Refund | null> {
  try {
    const list = await stripe.refunds.list({ charge: chargeId, limit: 10 });
    return (
      list.data.find(
        (r) =>
          r.metadata?.source === source &&
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

export async function transferOf(stripe: Stripe, charge: Stripe.Charge): Promise<Stripe.Transfer | null> {
  const t = charge.transfer;
  if (!t) return null;
  if (typeof t === "string") return stripe.transfers.retrieve(t);
  return t;
}
