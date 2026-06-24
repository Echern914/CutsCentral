import express, { Router } from "express";
import type Stripe from "stripe";
import { logger } from "../logger.js";
import { applyConnectEvent, connectEnabled, verifyConnectWebhook } from "../billing/connect.js";

/**
 * Stripe CONNECT webhook receiver — SEPARATE endpoint + secret from the platform
 * subscription webhook (webhooks.stripe.ts), so connected-account events
 * (account.updated, payment_intent.*, charge.*) never touch the subscription
 * reducer. Mounted BEFORE the global express.json() because signature
 * verification hashes the exact raw bytes.
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
    logger.warn({ err }, "connect webhook signature rejected");
    res.status(400).json({ error: "bad_signature" });
    return;
  }
  await applyConnectEvent(event);
  res.json({ received: true });
});
