import type { Response } from "express";
import type Stripe from "stripe";
import { logger } from "../logger.js";
import { stripeClient } from "./stripe.js";
import { errorClassification } from "./stripeErrors.js";

/**
 * 🔴 A WEBHOOK IS ACTED ON ONLY AS STRIPE ITSELF HAS IT.
 *
 * The signature proves the body was signed with our webhook secret - which
 * proves nothing once that secret has leaked (a hosting provider's environment
 * is exactly where it lives). With it, anyone could post a signed
 * `payment_intent.succeeded` naming a real PaymentIntent id - those ids sit in
 * our database - and `promoteHoldForPaidIntent` would turn an unpaid hold into
 * a booking. Every handler trusted `event.data.object` as delivered.
 *
 * So after the signature, the event is fetched back from Stripe by its id, with
 * our SECRET KEY (a different credential from the webhook secret), and only
 * Stripe's copy goes on to the receipt and the handlers:
 *   - an id Stripe has never issued is refused (400) - a forgery;
 *   - a real id under a different type is refused - a forgery;
 *   - a real id with a doctored body is handled with STRIPE's data, so the
 *     doctoring changes nothing;
 *   - Stripe unreachable: 503, nothing recorded, and Stripe redelivers (it
 *     retries for three days) - a delivery is never acted on unconfirmed.
 *
 * One extra API call per webhook; a fraction of Stripe's rate limit.
 */

/**
 * Stripe's copy of the event the signed delivery names (its id, on its
 * account), or null when Stripe has no such event. Transport failures throw.
 */
export type StripeEventFetcher = (signed: Stripe.Event) => Promise<Stripe.Event | null>;

function isMissing(err: unknown): boolean {
  const e = err as { statusCode?: number; code?: string } | null;
  return e?.statusCode === 404 || e?.code === "resource_missing";
}

const fetchFromStripe: StripeEventFetcher = async (signed) => {
  const account = signed.account ?? null;
  try {
    // Only the id (and account) is taken from the delivery. A connected
    // account's event lives on that account.
    return await stripeClient().events.retrieve(
      signed.id,
      undefined,
      account ? { stripeAccount: account } : undefined,
    );
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
};

let fetcher: StripeEventFetcher = fetchFromStripe;

/** Tests only: stand in for Stripe's API. null restores the real one. */
export function __setStripeEventFetcherForTests(f: StripeEventFetcher | null): void {
  fetcher = f ?? fetchFromStripe;
}

export type ConfirmResult =
  | { ok: true; event: Stripe.Event }
  | { ok: false; reason: "unknown_event" | "type_mismatch" };

export async function confirmEventWithStripe(signed: Stripe.Event): Promise<ConfirmResult> {
  const real = await fetcher(signed);
  if (!real || real.id !== signed.id) return { ok: false, reason: "unknown_event" };
  if (real.type !== signed.type) return { ok: false, reason: "type_mismatch" };
  return { ok: true, event: real };
}

/**
 * For a webhook route: Stripe's copy of the event, or null after answering -
 * 400 for a forgery (logged by id and reason only, never the body), 503 when
 * Stripe could not be asked.
 */
export async function confirmedOrAnswered(
  signed: Stripe.Event,
  res: Response,
  source: "stripe" | "connect",
): Promise<Stripe.Event | null> {
  let result: ConfirmResult;
  try {
    result = await confirmEventWithStripe(signed);
  } catch (err) {
    logger.error(
      { stripeEventId: signed.id, source, errName: errorClassification(err) },
      "stripe webhook: could not confirm the event with Stripe - told Stripe to redeliver",
    );
    res.status(503).json({ error: "confirm_unavailable" });
    return null;
  }
  if (!result.ok) {
    logger.warn(
      { stripeEventId: signed.id, stripeEventType: signed.type, source, reason: result.reason },
      "stripe webhook refused: correctly signed, but Stripe has no such event - forged or replayed with a leaked secret",
    );
    res.status(400).json({ error: "unconfirmed_event" });
    return null;
  }
  return result.event;
}
