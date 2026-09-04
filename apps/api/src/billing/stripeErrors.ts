/**
 * WHAT A STRIPE ERROR IS ALLOWED TO MEAN, AND TO SAY.
 *
 * Two questions every money path has to answer about a thrown error, and
 * both were being answered differently in different files:
 *
 *  1. DID ANYTHING HAPPEN? A card decline or a rejected request is
 *     DEFINITIVE - Stripe answered, and the answer was no. A socket hang-up,
 *     a timeout, a 5xx from Stripe is AMBIGUOUS - the request may have been
 *     accepted and acted on before the reply was lost. Treating an ambiguous
 *     error as "failed" is how a customer gets charged while our ledger says
 *     declined, and the barber then collects the fee a second time at the
 *     chair. The affiliate credit engine drew this line first; every charge,
 *     refund and credit now draws it here, in one place.
 *
 *  2. WHAT MAY BE LOGGED? A Stripe error object carries the request that
 *     failed - and for a card error, the PaymentIntent it failed on,
 *     client_secret included. pino's error serializer copies every enumerable
 *     property, so `logger.error({ err })` ships all of that to whatever keeps
 *     our logs. Only the classification below is ever logged for money.
 */

const DEFINITIVE_STRIPE_TYPES = new Set([
  "StripeCardError",
  "StripeInvalidRequestError",
  "StripeAuthenticationError",
  "StripePermissionError",
  "StripeRateLimitError",
  "StripeIdempotencyError",
]);

export interface StripeErrorFacts {
  /** True when Stripe answered and nothing was applied. False = unknown. */
  definitive: boolean;
  /** Short fixed classification: "card_error", "transport_error", ... */
  classification: string;
  /** Stripe's own error code / decline code, when it gave one. */
  code: string | null;
  /** Stripe's request id - safe, and what support needs to find the call. */
  requestId: string | null;
  statusCode: number | null;
}

/**
 * The ONLY view of a Stripe error that leaves this process: fixed fields,
 * no message text (a message can quote a card number a customer typed into
 * the wrong box), no raw request, no headers, no nested objects.
 */
/**
 * Codes Stripe only ever returns as the ANSWER to a charge - the card was
 * tried and refused. An error carrying one of these, or a decline code, or
 * the PaymentIntent it failed on, is a card error whatever its `type` says.
 */
const CARD_ANSWER_CODES = new Set([
  "card_declined",
  "expired_card",
  "incorrect_cvc",
  "incorrect_number",
  "insufficient_funds",
  "processing_error",
  "authentication_required",
  "card_not_supported",
  "do_not_honor",
]);

export function stripeErrorFacts(err: unknown): StripeErrorFacts {
  const e = (err ?? {}) as {
    type?: unknown;
    code?: unknown;
    decline_code?: unknown;
    payment_intent?: unknown;
    requestId?: unknown;
    statusCode?: unknown;
  };
  const type = typeof e.type === "string" ? e.type : null;
  const cardAnswer =
    typeof e.decline_code === "string" ||
    (typeof e.code === "string" && CARD_ANSWER_CODES.has(e.code)) ||
    (typeof e.payment_intent === "object" && e.payment_intent !== null);
  const definitive = (type !== null && DEFINITIVE_STRIPE_TYPES.has(type)) || cardAnswer;
  const classification = type
    ? type.replace(/^Stripe/, "").replace(/Error$/, "").replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase() + "_error"
    : cardAnswer
      ? "card_error"
      : "transport_error";
  const code =
    typeof e.decline_code === "string" ? e.decline_code : typeof e.code === "string" ? e.code : null;
  return {
    definitive,
    classification: classification === "_error" ? "transport_error" : classification,
    code,
    requestId: typeof e.requestId === "string" ? e.requestId : null,
    statusCode: typeof e.statusCode === "number" ? e.statusCode : null,
  };
}

/** True when Stripe answered and nothing was applied (safe to call it failed). */
export function isDefinitiveStripeError(err: unknown): boolean {
  return stripeErrorFacts(err).definitive;
}

/** One short token for a log line or a `lastError` column. Never prose. */
export function errorClassification(err: unknown): string {
  const facts = stripeErrorFacts(err);
  if (facts.classification !== "transport_error") return facts.classification;
  if (err instanceof Error && err.name && err.name !== "Error") {
    return err.name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().slice(0, 60);
  }
  return "transport_error";
}
