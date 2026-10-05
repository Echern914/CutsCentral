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

/**
 * WHICH PAYMENT ROWS ARE MONEY TOWARD THE SERVICE ITSELF: what was taken at
 * booking (deposit, pay-ahead, hold) and any balance collected at checkout.
 *
 * 🔴 AN ALLOW-LIST, NOT "EVERYTHING BUT FEES". Two other kinds of row hang off
 * an appointment and neither pays for the visit: a no-show or late-cancel FEE
 * (money for a visit that did not happen) and a TIP (the client's extra, on
 * top of the price). The readers that said `purpose !== "fee"` would have
 * counted every NEW purpose as service money the day it appeared: a tip would
 * have read as a deposit, lowered "still to collect" by its own amount, and
 * let the chair collect the balance short. A new purpose now joins nothing
 * until someone decides it should.
 */
export const SERVICE_PAYMENT_PURPOSES = ["booking", "service_checkout"] as const;

/**
 * Every row the shop's TAKINGS have always counted: the service money plus a
 * card-on-file fee (a no-show fee is real income for a missed slot). The
 * revenue, agenda, price-edit and trend readers use it, so their numbers are
 * exactly what they were before tips existed.
 *
 * 🔴 A TIP IS NOT IN IT (Eric, 2026-10-05: a tip shows on the appointment but
 * stays out of revenue). Left in, one $8 tip on a $40 cash cut that was never
 * checked out would have turned that cut's revenue into $8: revenue trusts
 * Stripe money over the ticket the moment any payment row exists
 * (engines/insightsWindow.ts).
 */
export const TAKINGS_PAYMENT_PURPOSES = ["booking", "fee", "service_checkout"] as const;

const SERVICE_PURPOSE_SET: ReadonlySet<string> = new Set(SERVICE_PAYMENT_PURPOSES);
const TAKINGS_PURPOSE_SET: ReadonlySet<string> = new Set(TAKINGS_PAYMENT_PURPOSES);

/** True for a row that is money toward the service - see SERVICE_PAYMENT_PURPOSES. */
export function isServicePayment(row: { purpose: string }): boolean {
  return SERVICE_PURPOSE_SET.has(row.purpose);
}

/** True for a row the shop's takings count - see TAKINGS_PAYMENT_PURPOSES. */
export function isTakingsPayment(row: { purpose: string }): boolean {
  return TAKINGS_PURPOSE_SET.has(row.purpose);
}

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
  /**
   * Every `Payment` row paid TOWARD THIS SERVICE - the booking deposit / pay-
   * ahead and any balance collected at checkout, all of them, added. [] when
   * none was ever created.
   *
   * 🔴 A LIST, AND NOT A FEE. An appointment can carry several rows since the
   * service-checkout release, and this used to take "the" row - the first the
   * database returned - so a sheet with a deposit AND a checkout balance showed
   * only one of them and told the barber the cut still owed money. The caller
   * reads only SERVICE_PAYMENT_PURPOSES, the same rule the checkout balance
   * uses (engines/serviceCheckout.ts): a no-show fee is money for a missed
   * visit, not toward this one, and a tip is the client's extra on top.
   */
  payments: PaymentRowFacts[];
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
   * The CardOnFile row, if the booking kept a card. brand/last4 are Stripe's
   * own words about a payment method it verified when the customer saved it -
   * the one source this engine accepts for `card` (see the honesty rule).
   */
  cardOnFile?: { brand: string | null; last4: string | null; status: string } | null;
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
   * Verified card identity. Populated ONLY from a card kept at booking
   * (paymentsMode card_on_file), whose brand and last four Stripe reported when
   * the customer saved it. Null for every other booking: ChairBack persists no
   * card data of its own and never synthesises this from a payload.
   */
  card: { brand: string; last4: string } | null;
  /**
   * A hosted receipt for money ChairBack took. Always null today - nothing in
   * the schema records one - so the sheet hides the action rather than linking
   * somewhere that does not exist.
   */
  receiptUrl: string | null;
  /**
   * A card KEPT at booking (card_on_file), and what became of it: `saved` =
   * held, nothing charged; `charged` = a no-show / late-cancel fee was taken
   * (the Payment row carries the money); `failed` = the charge was declined and
   * the fee is owed at the chair; `released` = let go. Null when none was kept.
   */
  cardOnFile: { status: string } | null;
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
  // The only card facts this engine will ever repeat: Stripe's, about a card it
  // verified when the customer saved it. Never synthesised from a payload.
  const cardFacts =
    input.cardOnFile?.brand && input.cardOnFile.last4
      ? { brand: input.cardOnFile.brand, last4: input.cardOnFile.last4 }
      : null;
  const cardOnFile = input.cardOnFile ? { status: input.cardOnFile.status } : null;
  const onlineCents = input.payments.reduce((sum, p) => sum + stripeCollectedCents(p), 0);
  const inPersonCents = Math.max(0, dollarsToCents(input.chairPaid));
  const collectedCents = onlineCents + inPersonCents;
  const refundedCents = input.payments.reduce((sum, p) => sum + Math.max(0, p.refundedAmount), 0);
  const authorizedCents = input.payments.reduce((sum, p) => sum + stripeAuthorizedCents(p), 0);
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
  if (input.external && input.payments.length === 0) {
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
      card: cardFacts,
      receiptUrl: null,
      cardOnFile,
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
    card: cardFacts,
    receiptUrl: null,
    cardOnFile,
  };
}
