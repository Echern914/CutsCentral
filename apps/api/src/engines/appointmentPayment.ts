/**
 * THE ONE PLACE THAT DECIDES WHAT CHAIRBACK KNOWS ABOUT AN APPOINTMENT'S MONEY.
 *
 * Two independent piles of money can exist against a single booking and they
 * NEVER overlap, so they simply add:
 *
 *   - STRIPE (`Payment`): what a customer paid online before the cut, in
 *     `ahead` or `deposit` mode. Cents, reconciled by the webhook.
 *   - THE CHAIR (`Appointment.paidAmount`): what the barber collected in
 *     person at checkout, keyed by `paidMethod`. Dollars, on the appointment
 *     row itself.
 *
 * Everything the appointment sheet says about payment is derived HERE, from
 * those two facts and the ticket price, so the day agenda and the sheet can
 * never drift into two different opinions about whether a cut is paid.
 *
 * 🔴 THE HONESTY RULE. ChairBack only claims what it can verify from its OWN
 * records. Three consequences that are easy to get wrong:
 *
 *  1. AN ACUITY-OWNED BOOKING HAS NO CHAIRBACK PAYMENT TRUTH. Acuity can take
 *     a deposit, a full payment or nothing at all and none of it reaches us -
 *     there is no payment field on the appointment payload we ingest. Such a
 *     row is `external`, never `unpaid`: telling a barber a booking is unpaid
 *     when we simply cannot see it is a lie that costs them money at the chair.
 *     THE RULE CUTS BOTH WAYS. A `Payment` row exists only because ChairBack
 *     itself ran a checkout for that appointment, so it is OUR record of money
 *     we took. It is disclosed no matter what the caller believes about
 *     ownership: `external` can silence a guess, never a fact. (FadesByMikey,
 *     2026-09-02: an ownership bug flagged a completed, deposit-paid booking
 *     as Acuity's, and the sheet swore "No ChairBack payment recorded" about
 *     $10 sitting in the barber's Stripe balance.)
 *  2. AN AUTHORIZED HOLD IS NOT COLLECTED MONEY. `requires_capture` means
 *     Stripe is holding a card, not that the shop has been paid, so it never
 *     counts toward `collectedCents` - the balance stays owed and the barber
 *     can still take cash. It IS surfaced separately so the sheet can say a
 *     card is on file rather than pretending nothing happened.
 *  3. CHAIRBACK STORES NO CARD DATA AT ALL. Not a PAN, not a CVC, and not even
 *     the brand/last-four Stripe would happily hand over - the `Payment` model
 *     has no column for any of it. `card` is therefore null on every row
 *     today; the field exists so that if a verified brand/last-four is ever
 *     persisted, ONE place lights it up and the sheet renders it. Never
 *     synthesize it from a description string or a raw provider payload.
 */

/** The Stripe intent statuses under which money has actually MOVED to the shop. */
const STRIPE_COLLECTED_STATUSES = new Set([
  "succeeded",
  "partially_refunded",
  "refunded",
]);

/** Stripe statuses that mean a card is authorized but NOT captured. */
const STRIPE_AUTHORIZED_STATUSES = new Set(["requires_capture"]);

/** The Stripe half of a booking's money, exactly as the `Payment` row records it. */
export interface PaymentRowFacts {
  status: string;
  /** Intent amount in cents. */
  amount: number;
  /** Cents actually captured (hold mode); null when capture is automatic. */
  capturedAmount: number | null;
  refundedAmount: number;
}

export interface AppointmentPaymentInput {
  /** Ticket price in DOLLARS (`Appointment.priceAtBooking`); null = unpriced. */
  price: number | null;
  /** The `Payment` row for this appointment, if one was ever created. */
  payment: PaymentRowFacts | null;
  /** Dollars collected at the chair (`Appointment.paidAmount`); null = not checked out. */
  chairPaid: number | null;
  /** "cash" | "direct" | "card" | "other" - a LABEL, never a card record. */
  chairMethod: string | null;
  /**
   * `Appointment.paidAt` is set - the barber closed the chair moment, whatever
   * the figure was. Load-bearing for the COMP: a cut given away records
   * `paidAmount = 0`, and without this the arithmetic alone would keep saying
   * the full ticket is owed on a booking the barber already settled.
   */
  chairCheckedOut: boolean;
  /**
   * True when the booking belongs to another system (an Acuity/Square `Visit`,
   * or a native row linked to one - see engines/visitOrigin.ts). Forces the
   * `external` state ONLY while there is no `Payment` row: money ChairBack
   * itself collected is always disclosed.
   */
  external: boolean;
}

/**
 * What ChairBack is willing to SAY about this booking's money.
 *
 *  - `external` - owned elsewhere; we hold no payment record and say so.
 *  - `unpaid` - ours, nothing collected.
 *  - `deposit` - ours, partially collected, a balance still owed.
 *  - `paid` - ours, the whole ticket is collected.
 *  - `refunded` - ours, money was collected and has since been fully returned.
 */
export type PaymentState = "external" | "unpaid" | "deposit" | "paid" | "refunded";

export interface AppointmentPaymentSnapshot {
  state: PaymentState;
  /** Ticket total in cents; null when the booking carries no price. */
  totalCents: number | null;
  /** Money ChairBack can prove reached the shop (Stripe captured + chair). */
  collectedCents: number;
  /** The Stripe half of `collectedCents`, for "paid online" copy. */
  onlineCents: number;
  /** The chair half of `collectedCents`. */
  inPersonCents: number;
  /** Cents refunded through Stripe. 0 when nothing was returned. */
  refundedCents: number;
  /**
   * Cents on an UNCAPTURED authorization. Not collected, and it does not
   * reduce what is owed - purely "a card is being held for this booking".
   */
  authorizedCents: number;
  /** What is still owed. Null when the ticket has no price to measure against. */
  remainingCents: number | null;
  /** "cash" | "direct" | "card" | "other" | null - how the chair was paid. */
  method: string | null;
  /**
   * Verified card identity. Always null: ChairBack persists no card data (see
   * the honesty rule above). Kept so a future verified source has one seam.
   */
  card: { brand: string; last4: string } | null;
  /**
   * A hosted receipt for money ChairBack took. Always null today - nothing in
   * the schema records one - so the sheet hides the action rather than linking
   * somewhere that does not exist.
   */
  receiptUrl: string | null;
}

function dollarsToCents(dollars: number | null): number {
  if (dollars === null || !Number.isFinite(dollars)) return 0;
  return Math.round(dollars * 100);
}

/** Cents Stripe has actually settled to the shop, net of refunds. Never negative. */
export function stripeCollectedCents(payment: PaymentRowFacts | null): number {
  if (!payment || !STRIPE_COLLECTED_STATUSES.has(payment.status)) return 0;
  const cents = (payment.capturedAmount ?? payment.amount) - payment.refundedAmount;
  return Math.max(0, cents);
}

/** Cents on an uncaptured authorization (hold mode). Zero for every other status. */
export function stripeAuthorizedCents(payment: PaymentRowFacts | null): number {
  if (!payment || !STRIPE_AUTHORIZED_STATUSES.has(payment.status)) return 0;
  return Math.max(0, payment.amount);
}

/**
 * Derive the payment snapshot. Pure: no database, no Stripe, no clock - which
 * is what makes every branch of the honesty rule directly testable.
 */
export function appointmentPaymentSnapshot(
  input: AppointmentPaymentInput,
): AppointmentPaymentSnapshot {
  const totalCents = input.price === null ? null : Math.max(0, dollarsToCents(input.price));
  const onlineCents = stripeCollectedCents(input.payment);
  const inPersonCents = Math.max(0, dollarsToCents(input.chairPaid));
  const collectedCents = onlineCents + inPersonCents;
  const refundedCents = Math.max(0, input.payment?.refundedAmount ?? 0);
  const authorizedCents = stripeAuthorizedCents(input.payment);
  // A closed chair moment owes NOTHING, even when the figure was zero: the
  // barber comped the cut, and telling them $40 is still due on a booking they
  // deliberately gave away is the same class of lie as guessing at Acuity.
  const remainingCents = input.chairCheckedOut
    ? 0
    : totalCents === null
      ? null
      : Math.max(0, totalCents - collectedCents);

  // A booking another system owns short-circuits everything: we report the
  // ticket we mirrored and refuse to characterize money we cannot see.
  //
  // UNLESS a Payment row exists. That row is written by ChairBack's own
  // checkout for this exact appointment, so the money is something we CAN
  // see - and an `external` flag that disagrees is the flag that is wrong, not
  // the record. Falling through here is what keeps a mislabeled origin from
  // ever hiding a deposit again.
  if (input.external && input.payment === null) {
    return {
      state: "external",
      totalCents,
      collectedCents: 0,
      onlineCents: 0,
      inPersonCents: 0,
      refundedCents: 0,
      authorizedCents: 0,
      remainingCents: null,
      method: null,
      card: null,
      receiptUrl: null,
    };
  }

  // Money came in and every cent of it went back out. Said as its own state
  // because "unpaid" would erase the fact that a refund happened at all.
  const state: PaymentState =
    refundedCents > 0 && collectedCents === 0
      ? "refunded"
      : collectedCents === 0 && !input.chairCheckedOut
        ? "unpaid"
        : remainingCents === null || remainingCents === 0
          ? "paid"
          : "deposit";

  return {
    state,
    totalCents,
    collectedCents,
    onlineCents,
    inPersonCents,
    refundedCents,
    authorizedCents,
    remainingCents,
    method: input.chairMethod ?? null,
    card: null,
    receiptUrl: null,
  };
}
