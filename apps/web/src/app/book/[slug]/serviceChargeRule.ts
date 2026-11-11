/**
 * A shop that will not book online without the client's OK to charge their
 * saved card for the service.
 *
 * The box itself is unchanged - the same words, from one file
 * (`@chairback/config/checkoutConsent`), ticked only by the client. What a
 * shop can now decide is that booking online depends on it. So the page has to
 * say that the shop requires it, keep Confirm from working until it is ticked
 * and say why, and cope with the shop switching the rule on while this page
 * was open (the server answers SERVICE_CHARGE_CONSENT_REQUIRED with the
 * current terms, and nothing is booked).
 */

/** The part of the page's money terms this rule reads. */
export interface ServiceChargeTerms {
  collects: "payment" | "card" | null;
  /** Optional = an older API, which never requires it. */
  serviceChargeConsentRequired?: boolean;
}

/** Does this shop require the tick to book online? */
export function serviceChargeTickRequired(terms: ServiceChargeTerms | null | undefined): boolean {
  return terms?.collects === "card" && terms.serviceChargeConsentRequired === true;
}

/** Is Confirm held back because a required tick is missing? */
export function serviceChargeBlocksConfirm(
  terms: ServiceChargeTerms | null | undefined,
  ticked: boolean,
): boolean {
  return serviceChargeTickRequired(terms) && !ticked;
}

/** Inside the box, so the client knows it is the shop's rule and not a default. */
export function serviceChargeRequiredNote(shopName: string): string {
  return `${shopName} requires this to book online. You can still pay another way in person.`;
}

/** Under the Confirm button while the required box is empty. */
export const SERVICE_CHARGE_REQUIRED_HINT =
  "Tick the box that lets the shop charge your saved card to confirm.";

/**
 * The shop switched the rule on while the booking page was open
 * (SERVICE_CHARGE_CONSENT_REQUIRED). Nothing was booked or held.
 */
export const SERVICE_CHARGE_REQUIRED_MESSAGE =
  "This shop now requires your OK to charge your saved card for the service. Nothing was booked. Tick the box and confirm again.";
