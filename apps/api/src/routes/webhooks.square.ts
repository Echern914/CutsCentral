import express, { Router } from "express";
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { ingestSquareBooking } from "../square/ingest.js";
import { verifySquareSignature } from "../square/signature.js";
import { squareWebhookEnvelopeSchema } from "../square/types.js";
import { squareEnabled } from "../square/client.js";

const env = apiEnv();

/**
 * App-level Square webhook receiver. Unlike Acuity (per-shop secret in the URL),
 * Square sends ALL merchants' events to ONE endpoint, so we route by the
 * envelope's merchant_id -> SquareConnection -> shop.
 *
 * Signature: HMAC-SHA256 of (notificationUrl + rawBody), base64, in the
 * x-square-hmacsha256-signature header. The notificationUrl must byte-match what
 * is configured in the Square Developer Console — we build it once from
 * API_BASE_URL. In production the signature key is required; if it's unset we
 * reject (no fall-through, since Square always provisions one).
 *
 * Ingest FIRST, then ack 200 — a 5xx makes Square retry, and ingest is
 * idempotent (Visit unique constraint), so retries never duplicate. Events for
 * unknown merchants / oauth.authorization.revoked are handled and 200'd.
 */
export const squareWebhookRouter: Router = Router();

// The exact public URL Square is configured to POST to (must match byte-for-byte).
const NOTIFICATION_URL = `${env.API_BASE_URL.replace(/\/$/, "")}/webhooks/square`;

squareWebhookRouter.post("/", express.raw({ type: "*/*" }), async (req, res) => {
  if (!squareEnabled()) {
    res.status(503).json({ error: "square_disabled" });
    return;
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

  // Verify signature (URL + body). Required in production; if no key is set we
  // refuse rather than trust an unsigned payload.
  if (!env.SQUARE_WEBHOOK_SIGNATURE_KEY) {
    logger.error("square webhook received but SQUARE_WEBHOOK_SIGNATURE_KEY unset - rejecting");
    res.sendStatus(401);
    return;
  }
  const sig = req.header("x-square-hmacsha256-signature");
  if (!verifySquareSignature(raw, sig, env.SQUARE_WEBHOOK_SIGNATURE_KEY, NOTIFICATION_URL)) {
    logger.warn("square webhook bad signature");
    res.sendStatus(401);
    return;
  }

  let envelope;
  try {
    envelope = squareWebhookEnvelopeSchema.parse(JSON.parse(raw.toString("utf8")));
  } catch (err) {
    logger.warn({ err }, "square webhook unparseable body");
    res.sendStatus(200); // nothing actionable; ack so Square stops retrying
    return;
  }

  // Seller disconnected our app: mark the connection revoked, surface reconnect.
  if (envelope.type === "oauth.authorization.revoked" && envelope.merchant_id) {
    await prisma.squareConnection.updateMany({
      where: { squareMerchantId: envelope.merchant_id },
      data: { revokedAt: new Date() },
    });
    logger.warn({ merchantId: envelope.merchant_id }, "square authorization revoked");
    res.sendStatus(200);
    return;
  }

  const booking = envelope.data?.object?.booking;
  if (!envelope.merchant_id || !booking?.id) {
    res.sendStatus(200); // not a booking event we handle
    return;
  }

  const conn = await prisma.squareConnection.findFirst({
    where: { squareMerchantId: envelope.merchant_id, revokedAt: null },
    // Deterministic pick if a legacy collision exists (the OAuth callback now
    // blocks new ones): oldest connection wins, so routing can't flip between
    // shops run-to-run based on the query planner.
    orderBy: { connectedAt: "asc" },
    select: { shopId: true },
  });
  if (!conn) {
    logger.warn({ merchantId: envelope.merchant_id }, "square webhook for unknown/revoked merchant");
    res.sendStatus(200); // ack: nothing to do for a merchant we don't track
    return;
  }
  const shop = await prisma.shop.findUnique({ where: { id: conn.shopId } });
  if (!shop) {
    res.sendStatus(200);
    return;
  }

  try {
    // Pass the webhook's booking through; ingest re-fetches the authoritative
    // record (the webhook payload can be partial). Idempotent.
    await ingestSquareBooking(shop, booking.id);
    res.sendStatus(200);
  } catch (err) {
    logger.error({ err, shopId: shop.id, bookingId: booking.id }, "square webhook ingest failed");
    res.sendStatus(500); // Square retries; idempotent ingest absorbs it
  }
});
