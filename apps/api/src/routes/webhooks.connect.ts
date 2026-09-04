import express, { Router } from "express";
import type Stripe from "stripe";
import { logger } from "../logger.js";
import { applyConnectEvent, connectEnabled, verifyConnectWebhook } from "../billing/connect.js";
import { claimStripeEvent, finishStripeEvent, livemodeMismatch } from "../billing/stripeEvents.js";
import { errorClassification } from "../billing/stripeErrors.js";

/**
 * Stripe CONNECT webhook receiver — SEPARATE endpoint + secret from the platform
 * subscription webhook (webhooks.stripe.ts), so connected-account events
 * (account.updated, payment_intent.*, charge.*) never touch the subscription
 * reducer. Mounted BEFORE the global express.json() because signature
 * verification hashes the exact raw bytes.
 *
 * Same walls as the platform endpoint, in the same order: signature, then
 * livemode, then the shared receipt table (one event id is one event whichever
 * endpoint Stripe routed it to - a payment_intent.succeeded delivered to BOTH
 * is applied once), then the handlers, then settle.
 */
export const connectWebhookRouter: Router = Router();

connectWebhookRouter.post("/", express.raw({ type: "*/*" }), async (req, res) => {
  if (!connectEnabled()) {
    res.status(503).json({ error: "connect_disabled" });
    return;
  }
  const signature = req.header("stripe-signature");
  if (!signature) {
    res.status(400).json({ error: "missing_signature" });
    return;
  }
  let event: Stripe.Event;
  try {
    event = verifyConnectWebhook(req.body as Buffer, signature);
  } catch (err) {
    // Classification only - see webhooks.stripe.ts: the error carries the
    // unverified body.
    logger.warn({ errName: errorClassification(err) }, "connect webhook signature rejected");
    res.status(400).json({ error: "bad_signature" });
    return;
  }
  logger.info(
    { stripeEventType: event.type, stripeEventId: event.id, account: event.account ?? null },
    "connect webhook received",
  );

  if (livemodeMismatch(event)) {
    logger.warn(
      { stripeEventId: event.id, livemode: event.livemode },
      "connect webhook refused: event mode does not match this process's key",
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
    res.status(503).json({ error: "in_flight" });
    return;
  }

  try {
    await applyConnectEvent(event);
  } catch (err) {
    await finishStripeEvent(event.id, { ok: false, error: errorClassification(err) });
    logger.error(
      { stripeEventId: event.id, stripeEventType: event.type, errName: errorClassification(err) },
      "connect webhook handler failed - told Stripe to redeliver",
    );
    res.status(500).json({ error: "handler_failed" });
    return;
  }
  await finishStripeEvent(event.id, { ok: true });
  res.json({ received: true });
});
