import express, { Router } from "express";
import type Stripe from "stripe";
import { logger } from "../logger.js";
import {
  applyStripeEvent,
  billingEnabled,
  verifyStripeWebhook,
} from "../billing/stripe.js";
import { applyPaymentEvent } from "../billing/payments.js";

/**
 * Stripe webhook receiver. Mounted BEFORE the global express.json() (like the
 * Acuity/Twilio webhooks) because signature verification hashes the exact raw
 * bytes - a re-serialized JSON body would never verify.
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
    logger.warn({ err }, "stripe webhook signature rejected");
    res.status(400).json({ error: "bad_signature" });
    return;
  }
  // Subscription/billing events fold into Shop state. Destination-charge
  // payment events (payment_intent.*, charge.refunded) fire on the PLATFORM
  // account too, so reconcile them here as well - applyPaymentEvent ignores
  // anything that isn't a payment event, and is idempotent if the Connect
  // endpoint also delivers it. This makes payment reconciliation robust to
  // whichever endpoint Stripe routes the event to.
  await applyStripeEvent(event);
  await applyPaymentEvent(event);
  res.json({ received: true });
});
