import express, { Router } from "express";
import type Stripe from "stripe";
import { logger } from "../logger.js";
import {
  applyStripeEvent,
  billingEnabled,
  verifyStripeWebhook,
} from "../billing/stripe.js";
import { applyPaymentEvent } from "../billing/payments.js";
import { claimStripeEvent, finishStripeEvent, livemodeMismatch } from "../billing/stripeEvents.js";
import { errorClassification } from "../billing/stripeErrors.js";
import { applyAffiliateStripeEvent } from "../services/affiliateQualification.js";

/**
 * Stripe webhook receiver. Mounted BEFORE the global express.json() (like the
 * Acuity/Twilio webhooks) because signature verification hashes the exact raw
 * bytes - a re-serialized JSON body would never verify.
 *
 * ORDER OF THE WALLS, and why each is where it is:
 *   1. signature   - an unsigned or mis-signed body is refused before it
 *                    touches the database at all
 *   2. livemode    - a test-mode event never reaches a live process's handlers
 *   3. receipt     - one durable row per event id; a duplicate is acknowledged
 *                    without being applied, a failed delivery is re-applied
 *   4. handlers    - each still replay-safe on its own (that is not relaxed)
 *   5. settle      - processed, or failed + a 500 so Stripe redelivers
 */
export const stripeWebhookRouter: Router = Router();

stripeWebhookRouter.post("/", express.raw({ type: "*/*" }), async (req, res) => {
  if (!billingEnabled()) {
    res.status(503).json({ error: "billing_disabled" });
    return;
  }
  const signature = req.header("stripe-signature");
  if (!signature) {
    res.status(400).json({ error: "missing_signature" });
    return;
  }
  let event: Stripe.Event;
  try {
    event = verifyStripeWebhook(req.body as Buffer, signature);
  } catch (err) {
    // Classification only. The error object carries the header AND the raw
    // body - which, on this branch, is exactly the content nobody has vouched
    // for. An attacker's payload must not be laundered into the log stream.
    logger.warn({ errName: errorClassification(err) }, "stripe webhook signature rejected");
    res.status(400).json({ error: "bad_signature" });
    return;
  }
  // 🔴 RECORD WHAT ACTUALLY ARRIVES - event type and id only, no payload, no
  // customer, no amounts.
  //
  // Why this line exists: `invoice.paid` is the ONLY trigger for a referral
  // reward anywhere in the codebase (billing/stripe.ts has the single call to
  // grantReferralReward). If that event is not subscribed on the live endpoint
  // then no referrer has ever been paid - and nothing would say so, because an
  // event we do not handle falls through `default: return` in silence.
  logger.info({ stripeEventType: event.type, stripeEventId: event.id }, "stripe webhook received");

  if (livemodeMismatch(event)) {
    logger.warn(
      { stripeEventId: event.id, livemode: event.livemode },
      "stripe webhook refused: event mode does not match this process's key",
    );
    res.status(400).json({ error: "livemode_mismatch" });
    return;
  }

  const claim = await claimStripeEvent({
    id: event.id,
    type: event.type,
    livemode: Boolean(event.livemode),
    account: event.account ?? null,
  });
  if (claim === "duplicate") {
    res.json({ received: true, duplicate: true });
    return;
  }
  if (claim === "inflight") {
    // Another replica holds this delivery. A retriable answer, never a 200:
    // a 200 here would tell Stripe the event is done while it may yet fail.
    res.status(503).json({ error: "in_flight" });
    return;
  }

  try {
    // Subscription/billing events fold into Shop state. Destination-charge
    // payment events (payment_intent.*, charge.refunded) fire on the PLATFORM
    // account too, so reconcile them here as well - applyPaymentEvent ignores
    // anything that isn't a payment event, and is idempotent if the Connect
    // endpoint also delivers it.
    await applyStripeEvent(event);
    await applyPaymentEvent(event);
    // Affiliate qualification, LAST and strictly additive. It keeps its own
    // event dedupe (a separate table) so its exact semantics and tests are
    // untouched; it returns immediately unless both affiliate flags are on,
    // and it never throws.
    await applyAffiliateStripeEvent(event);
  } catch (err) {
    await finishStripeEvent(event.id, { ok: false, error: errorClassification(err) });
    logger.error(
      { stripeEventId: event.id, stripeEventType: event.type, errName: errorClassification(err) },
      "stripe webhook handler failed - told Stripe to redeliver",
    );
    res.status(500).json({ error: "handler_failed" });
    return;
  }
  await finishStripeEvent(event.id, { ok: true });
  res.json({ received: true });
});
