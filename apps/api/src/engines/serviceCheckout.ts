import { serviceChargeAuthorized } from "@chairback/config";
import { stripeCollectedCents } from "./appointmentPayment.js";

/**
 * WHAT THE CUSTOMER STILL OWES FOR THE SERVICE, AND WHAT MAY BE DONE ABOUT IT.
 *
 * Pure: no database, no Stripe, no clock. Every rule below is therefore
 * directly testable, which matters more here than anywhere else in the app -
 * this is the function that decides how much of someone's money to take.
 *
 * 🔴 THE AMOUNT IS NEVER THE CLIENT'S TO SEND. The barber's screen shows a
 * figure and asks them to confirm it, but the figure it is allowed to confirm
 * is computed here, from the ticket and from payments already recorded. A
 * request that names its own amount is checked against this and refused if it
 * asks for more.
 *
 * 🔴 A FEE IS NOT A PAYMENT TOWARD THE HAIRCUT. A no-show fee already charged
 * to this appointment is real money the shop took, but it does not reduce what
 * is owed for a service that is now being performed - so `purpose: "fee"` rows
 * are excluded from the balance. Counting them would hand the customer a free
 * cut because they were once charged for missing one.
 */

/** A `Payment` row reduced to what the balance maths needs. */
export interface CheckoutPaymentFacts {
  purpose: string;
  status: string;
  amount: number;
  capturedAmount: number | null;
  refundedAmount: number;
}

/** The saved card, as stored, including the authorisation it carries. */
export interface CheckoutCardFacts {
  appointmentId: string;
  seriesId: string | null;
  status: string;
  stripePaymentMethodId: string | null;
  brand: string | null;
  last4: string | null;
  serviceChargeConsentVersion: string | null;
  serviceChargeConsentAt: Date | null;
  serviceChargeConsentScope: string | null;
}

export interface ServiceCheckoutInput {
  appointmentId: string;
  seriesId: string | null;
  /** Ticket price in DOLLARS (`Appointment.priceAtBooking`); null = unpriced. */
  price: number | null;
  /** Dollars already recorded as collected at the chair. Null = not checked out. */
  chairPaid: number | null;
  /** True once `Appointment.paidAt` is set - the chair moment is closed. */
  chairCheckedOut: boolean;
  /** Every Payment row against this appointment, any purpose. */
  payments: CheckoutPaymentFacts[];
  /** The kept card, if this booking has one. */
  card: CheckoutCardFacts | null;
  /** True when another system owns this booking's money (Acuity/Square). */
  external: boolean;
}

/** Why a saved card cannot be offered. Each is shown to the barber verbatim. */
export type SavedCardBlocker =
  | "no_card"
  | "card_not_saved"
  | "no_service_consent"
  | "consent_not_for_this_appointment";

export interface ServiceCheckoutState {
  /** Ticket total in cents; null when the booking carries no price. */
  totalCents: number | null;
  /** Collected toward the SERVICE (booking + checkout + chair). Excludes fees. */
  collectedCents: number;
  /**
   * What is still owed. Null when there is no price to measure against, which
   * is a refusal to guess rather than a zero.
   */
  remainingCents: number | null;
  /**
   * The most that may be charged to a SAVED CARD. Equal to `remainingCents`,
   * and it is a ceiling, not a default: the barber may take less (a discount),
   * never more. A tip or an increased total is a new agreement with the
   * customer, and the barber pressing a button is not the customer making one.
   */
  maxSavedCardCents: number;
  /** True when a saved card may be offered at all. */
  savedCardEligible: boolean;
  /** Why not, when it may not. Null when it may. */
  savedCardBlocker: SavedCardBlocker | null;
  /** Display-safe card identity, for the "Charge card ending ••••4242" row. */
  card: { brand: string | null; last4: string | null } | null;
}

function dollarsToCents(dollars: number | null): number {
  if (dollars === null || !Number.isFinite(dollars)) return 0;
  return Math.round(dollars * 100);
}

/**
 * Cents already collected toward the SERVICE. A deposit counts. A balance
 * collected at a previous checkout counts. Cash counts. A no-show fee does not.
 */
export function serviceCollectedCents(
  payments: CheckoutPaymentFacts[],
  chairPaid: number | null,
): number {
  const stripe = payments
    .filter((p) => p.purpose !== "fee")
    .reduce((sum, p) => sum + stripeCollectedCents(p), 0);
  return stripe + Math.max(0, dollarsToCents(chairPaid));
}

export function serviceCheckoutState(input: ServiceCheckoutInput): ServiceCheckoutState {
  const totalCents = input.price === null ? null : Math.max(0, dollarsToCents(input.price));
  const collectedCents = serviceCollectedCents(input.payments, input.chairPaid);
  // A closed chair moment owes nothing, even at zero: the barber comped the
  // cut, and insisting the ticket is still due on a cut they gave away is the
  // same lie the payment snapshot already refuses to tell.
  const remainingCents = input.chairCheckedOut
    ? 0
    : totalCents === null
      ? null
      : Math.max(0, totalCents - collectedCents);

  const card = input.card;
  let blocker: SavedCardBlocker | null = null;
  if (!card) {
    blocker = "no_card";
  } else if (card.status !== "saved" || !card.stripePaymentMethodId) {
    // `pending` never completed, `released` was let go, `charging` is mid-flight,
    // `charged`/`failed` are spent. None of them is a card we may charge now.
    blocker = "card_not_saved";
  } else if (!card.serviceChargeConsentVersion || !card.serviceChargeConsentAt) {
    // The fee-only case, and the one that matters most: this customer agreed to
    // a no-show fee and nothing else.
    blocker = "no_service_consent";
  } else if (
    !serviceChargeAuthorized(card, {
      appointmentId: input.appointmentId,
      seriesId: input.seriesId,
    })
  ) {
    blocker = "consent_not_for_this_appointment";
  }

  // An externally-owned booking has no ChairBack balance to speak of, so there
  // is nothing to charge a card for either.
  if (input.external && input.payments.length === 0) {
    blocker = blocker ?? "no_card";
  }

  const maxSavedCardCents = Math.max(0, remainingCents ?? 0);
  return {
    totalCents,
    collectedCents,
    remainingCents,
    maxSavedCardCents,
    // Nothing owed is not an error, but it is not a charge either: offering a
    // card button that would take $0 is a dead end.
    savedCardEligible: blocker === null && maxSavedCardCents > 0,
    savedCardBlocker: blocker,
    card: card ? { brand: card.brand, last4: card.last4 } : null,
  };
}

/**
 * Is `requested` an amount this checkout may charge to a saved card?
 *
 * Lower is allowed - that is a discount, and the shop is free to take less than
 * it is owed. Higher is refused, because the customer authorised payment for
 * the service they booked, not whatever total the screen was later set to.
 */
export function savedCardAmountAllowed(
  state: ServiceCheckoutState,
  requestedCents: number,
): boolean {
  if (!Number.isInteger(requestedCents) || requestedCents <= 0) return false;
  return requestedCents <= state.maxSavedCardCents;
}
