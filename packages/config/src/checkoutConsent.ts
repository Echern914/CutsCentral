/**
 * THE ONE PLACE THAT SAYS WHAT A CUSTOMER AGREED TO WHEN THEY SAVED A CARD.
 *
 * ChairBack already asks a customer to keep a card on file so a shop is covered
 * against no-shows and late cancellations. That agreement is about FEES. It is
 * not permission to charge the same card for the haircut itself, and treating
 * it as though it were would be taking money on an agreement nobody made.
 *
 * So charging a saved card at checkout needs its own authorisation, collected
 * at booking, in words the customer actually read. This module owns those
 * words and their version, and both halves of the product read it from here:
 * the booking page renders `SERVICE_CHARGE_CONSENT.body`, and the API refuses a
 * charge unless the stored version is one this file still recognises. They
 * cannot drift into saying two different things.
 *
 * 🔴 VERSION IS A PROMISE, NOT A LABEL. The version recorded against a card is
 * the exact wording that customer accepted. Editing `body` without minting a
 * new `version` silently rewrites what past customers are held to. If the
 * meaning changes at all, add a new entry - the old one stays here forever so
 * a charge taken last month can still be explained.
 */

/** Which appointments one acceptance covers. */
export type ServiceChargeConsentScope = "single" | "series";

/**
 * 🔴 HOW LONG A CONSENTED CARD STAYS CHARGEABLE AFTER THE APPOINTMENT ENDS.
 *
 * Checkout happens AFTER the service, so a card cannot be let go the moment the
 * cut is marked done - a barber who presses Done first would otherwise find the
 * card gone when they came to collect thirty seconds later. It equally cannot
 * be held indefinitely: an open-ended right to charge somebody's card for a
 * haircut they had last month is not what they agreed to.
 *
 * 72 hours covers the realistic cases (collected at the chair, collected at the
 * end of the day, collected on the next shift) and expires on its own. After
 * it, the card is no longer eligible for a SERVICE charge and the ordinary
 * release path lets it go. The fee rules are unaffected - they have their own
 * window, in the shop's cancellation policy.
 */
export const SERVICE_CHARGE_RETENTION_HOURS = 72;

/** Has the window closed on charging this card for the service? */
export function serviceChargeWindowClosed(endsAt: Date, now: Date): boolean {
  return now.getTime() - endsAt.getTime() > SERVICE_CHARGE_RETENTION_HOURS * 60 * 60 * 1000;
}

export interface ServiceChargeConsent {
  /** Stored verbatim on the card. Never reused for different wording. */
  version: string;
  /** The checkbox label. Short enough to be read, complete enough to be fair. */
  label: string;
  /** The full terms shown beside it. */
  body: string;
}

/**
 * The current wording. A customer must tick this to make their saved card
 * eligible for a service charge; declining it keeps the card, keeps the
 * booking, and simply means they pay at the chair like everyone else.
 */
export const SERVICE_CHARGE_CONSENT_VERSION = "2026-10-03.v1";

export const SERVICE_CHARGE_CONSENT: ServiceChargeConsent = {
  version: SERVICE_CHARGE_CONSENT_VERSION,
  label: "Let this shop charge my saved card for the service when my appointment is done",
  body:
    "After your appointment, the shop can charge this card for the amount you owe " +
    "for the service - up to the price of what you booked, less anything you have " +
    "already paid. They will only do this once your appointment is finished. You " +
    "will get a receipt by email every time. You can pay another way at the chair " +
    "instead, and you can remove this card at any time from your appointment link.",
};

/**
 * The series wording. Kept separate, and accepted separately, because agreeing
 * that one haircut may be charged is not agreeing that twelve may be. A
 * standing appointment says so in its own sentence or it does not apply.
 */
export const SERVICE_CHARGE_CONSENT_SERIES: ServiceChargeConsent = {
  version: SERVICE_CHARGE_CONSENT_VERSION,
  label: "…and for every appointment in this standing series",
  body:
    "This applies to each appointment in the series you are booking, on the same " +
    "terms: only after each one is finished, only for what you owe for that " +
    "service, and always with a receipt. Cancelling the series ends it.",
};

/**
 * 🔴 KEEPING THE CARD FOR NEXT TIME - a third, separate agreement.
 *
 * The card-on-file consent covers THIS booking's no-show and late-cancellation
 * fees, and the card is let go after the visit. Keeping it for the client's
 * FUTURE appointments is a different use, and Stripe requires the customer to
 * be told the intended future use of a saved payment method before it is
 * saved for it. So it is its own unticked box, in these words, and the version
 * is stored on the card (SavedCard.consentVersion).
 *
 * It does NOT widen what the card may be charged for: future bookings are
 * covered for exactly what a card on file covers today (the shop's no-show and
 * late-cancellation policy), and a SERVICE charge still needs the customer's
 * own tick on that booking (SERVICE_CHARGE_CONSENT, scope `single`).
 *
 * Removal is promised only as what ChairBack can keep: the card is taken off
 * the shop's file. It says nothing about the customer's phone wallet, which
 * ChairBack cannot touch.
 */
export const SAVED_CARD_CONSENT_VERSION = "2026-09-30.v1";

export const SAVED_CARD_CONSENT: ServiceChargeConsent = {
  version: SAVED_CARD_CONSENT_VERSION,
  label: "Save this card for my future appointments at this shop",
  body:
    "The shop keeps this card on file for your future appointments here, so you " +
    "won't have to enter it again - on this phone you'll book with it in one tap, " +
    "and on a new phone we'll text you a code first. It's only used the way a card " +
    "on file is used today: for a no-show or a late cancellation under the shop's " +
    "policy, and for your service only on a booking where you tick the box that " +
    "allows it. Nothing is charged now. You can take it off the shop's file at any " +
    "time from your appointment link.",
};

/**
 * Every wording a stored consent may legitimately be on. A card whose version
 * is not in here is NOT chargeable for services - which is exactly what makes
 * every card saved before this shipped fee-only, with no backfill and no way
 * for a barber to vouch for consent on the customer's behalf.
 */
const HONOURED_VERSIONS: ReadonlySet<string> = new Set([SERVICE_CHARGE_CONSENT_VERSION]);

/**
 * May this saved card be charged for the SERVICE on this appointment?
 *
 * Every argument is a stored fact, so the answer is the same in the API, in a
 * test and in a support conversation. The deliberate refusals:
 *
 *  - no version, or one this build no longer honours -> no.
 *  - the customer WITHDREW it from their appointment link -> no, for good.
 *    The consent columns stay as the record of what was agreed; the
 *    withdrawal is what ends it, and nothing in the product can undo it.
 *  - `single` scope reached from a DIFFERENT appointment -> no. A card filed
 *    against one booking does not follow the customer to the next one.
 *  - `series` scope is the only thing that covers a sibling occurrence, and
 *    only within the same series.
 */
export function serviceChargeAuthorized(card: {
  serviceChargeConsentVersion: string | null;
  serviceChargeConsentAt: Date | null;
  serviceChargeConsentScope: string | null;
  /** Set when the customer took the permission back. Required, so no caller can forget it. */
  serviceChargeWithdrawnAt: Date | null;
  /** The appointment the consent was recorded against. */
  appointmentId: string;
  /** The series this card covers, when it covers one. */
  seriesId?: string | null;
}, target: { appointmentId: string; seriesId?: string | null }): boolean {
  if (!card.serviceChargeConsentVersion || !card.serviceChargeConsentAt) return false;
  if (card.serviceChargeWithdrawnAt) return false;
  if (!HONOURED_VERSIONS.has(card.serviceChargeConsentVersion)) return false;
  if (card.serviceChargeConsentScope === "single") {
    return card.appointmentId === target.appointmentId;
  }
  if (card.serviceChargeConsentScope === "series") {
    // Same appointment is always covered; a sibling only through a shared,
    // non-null series. Two null seriesIds are not "the same series".
    if (card.appointmentId === target.appointmentId) return true;
    return Boolean(card.seriesId) && card.seriesId === target.seriesId;
  }
  return false;
}
