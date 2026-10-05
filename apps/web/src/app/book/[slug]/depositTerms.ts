/**
 * The words for a deposit the shop keeps when the client cancels.
 *
 * One place, because the client meets them on three screens - the booking
 * page before Confirm, the card step, and their appointment page before
 * Cancel - and the three must never disagree about money.
 */

import type { BookShopData } from "./page";

type PaymentTerms = NonNullable<BookShopData["shop"]["payment"]>;

/**
 * The shop's CURRENT money terms, from a DEPOSIT_TERMS_CHANGED answer - or
 * null when the body isn't that shape. Read defensively: a malformed body
 * must never be shown as terms.
 */
export function readPaymentTerms(raw: unknown): PaymentTerms | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const collects = p.collects;
  if (collects !== "payment" && collects !== "card" && collects !== null) return null;
  if (typeof p.mode !== "string" || typeof p.sentence !== "string") return null;
  return {
    collects,
    mode: p.mode,
    depositAmountCents: typeof p.depositAmountCents === "number" ? p.depositAmountCents : null,
    nonRefundable: p.nonRefundable === true,
    sentence: p.sentence,
    cancellation: typeof p.cancellation === "string" ? p.cancellation : null,
  };
}

/** Appended to whatever line names the money taken at booking. */
export const DEPOSIT_KEPT_LINE = "It isn't refunded if you cancel.";

/**
 * The shop made its deposit non-refundable while the booking page was open.
 * Nothing was booked or charged (DEPOSIT_TERMS_CHANGED).
 */
export const DEPOSIT_TERMS_CHANGED_MESSAGE =
  "The shop just made its deposit non-refundable, so it isn't refunded if you cancel. Nothing was booked or charged. Confirm again to book.";

/** On the appointment page, before Cancel takes effect. */
export function keptOnCancelQuestion(amountCents: number): string {
  const dollars = amountCents % 100 === 0 ? String(amountCents / 100) : (amountCents / 100).toFixed(2);
  return `Your $${dollars} deposit isn't refunded if you cancel. Cancel anyway?`;
}
