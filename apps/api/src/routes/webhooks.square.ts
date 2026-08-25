import express, { Router } from "express";
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { admitEvent, processBookingEvent, settleEvent } from "../square/inbox.js";
import { verifySquareSignature } from "../square/signature.js";
import { squareWebhookEnvelopeSchema } from "../square/types.js";
import { squareEnabled } from "../square/client.js";
import { parseSquareEventRef } from "../engines/squareMirrorRules.js";

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

  // THE VERSION lives in `data.id`, which Square formats as
  // "<bookingId>:<version>" - the bare booking id is inside the booking object,
  // and reading data.id as an id would look right and never match. The version
  // is what makes out-of-order delivery detectable, since Square guarantees no
  // ordering. A mismatched id means the envelope is not self-consistent, so the
  // version is not trusted for it.
  const ref = parseSquareEventRef(envelope.data?.id);
  const eventVersion = ref.bookingId === booking.id ? ref.version : null;

  // PERSIST BEFORE PROCESSING. Square's event_id is the idempotency key for the
  // WORK, which the Visit upsert never was: a redelivery used to re-fetch the
  // booking, re-fetch the customer and re-run the punch pipeline, all of which
  // the upsert happily absorbed while doing every bit of it again.
  const admission = await admitEvent({
    eventId: envelope.event_id,
    merchantId: envelope.merchant_id,
    type: envelope.type,
    bookingId: booking.id,
    bookingVersion: eventVersion,
  });
  if (admission.kind === "duplicate") {
    logger.info({ eventId: envelope.event_id }, "square webhook: duplicate event - no work done");
    res.sendStatus(200);
    return;
  }
  if (admission.kind === "ignored") {
    res.sendStatus(200);
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
    await settleEvent(admission.rowId, "IGNORED", { lastError: "unknown_merchant" });
    res.sendStatus(200); // ack: nothing to do for a merchant we don't track
    return;
  }
  const shop = await prisma.shop.findUnique({ where: { id: conn.shopId } });
  if (!shop) {
    await settleEvent(admission.rowId, "IGNORED", { lastError: "shop_missing" });
    res.sendStatus(200);
    return;
  }

  try {
    // Self-echo is decided inside processBookingEvent: a booking ChairBack
    // created must reconcile its own outbound row, never import as a second
    // Visit on a chair that is already booked.
    const outcome = await processBookingEvent(
      shop,
      booking.id,
      booking.status,
      booking.seller_note,
      eventVersion,
    );
    // A stale event was deliberately not applied, so recording it as PROCESSED
    // would both overstate what happened and put a version into the applied
    // high water mark that we never acted on.
    await settleEvent(
      admission.rowId,
      outcome === "stale" ? "IGNORED" : "PROCESSED",
      { shopId: shop.id, ...(outcome === "stale" ? { lastError: "stale_version" } : {}) },
    );
    logger.info(
      { shopId: shop.id, eventId: envelope.event_id, outcome },
      "square webhook processed",
    );
    res.sendStatus(200);
  } catch (err) {
    // The ledger row is the retry queue now, so a 500 is no longer the only
    // thing standing between a transient failure and a lost booking. Still
    // returned, because Square retrying costs nothing and arrives sooner than
    // the sweep - and the duplicate that follows a successful retry is now
    // free.
    await settleEvent(admission.rowId, "FAILED", {
      shopId: shop.id,
      lastError: err instanceof Error ? err.name : "unknown",
    });
    logger.error({ err, shopId: shop.id, bookingId: booking.id }, "square webhook ingest failed");
    res.sendStatus(500);
  }
});
