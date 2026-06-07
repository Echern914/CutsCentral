import express, { Router } from "express";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { ingestAppointment } from "../ingest.js";

/**
 * Per-shop Acuity webhook receiver.
 *
 * Routing: the body carries NO account id, so the unguessable :webhookSecret in
 * the URL path identifies the shop. Unknown secret -> 404.
 *
 * Body: application/x-www-form-urlencoded with action,id,calendarID,
 * appointmentTypeID. We capture the RAW body (express.raw) so a signature can be
 * verified byte-exact. [VERIFY LIVE] OAuth dynamic-webhook signing key is
 * under-documented; until confirmed, the per-shop path token is the
 * authenticator and HMAC is skipped when no key is stored.
 *
 * We ack 200 fast, then ingest. Idempotent via unique constraints, so Acuity
 * re-deliveries never duplicate.
 */
export const acuityWebhookRouter: Router = Router();

acuityWebhookRouter.post(
  "/:webhookSecret",
  express.raw({ type: "application/x-www-form-urlencoded" }),
  async (req, res) => {
    const shop = await prisma.shop.findUnique({
      where: { webhookSecret: req.params.webhookSecret },
    });
    if (!shop) {
      res.sendStatus(404);
      return;
    }

    // req.body is a Buffer (raw). Parse the four form fields.
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const params = new URLSearchParams(raw.toString("utf8"));
    const action = params.get("action") ?? "";
    const id = params.get("id") ?? "";

    if (!id) {
      // Nothing actionable; ack so Acuity stops retrying.
      res.sendStatus(200);
      return;
    }

    // Ack immediately; process after. Idempotent ingest means retries are safe.
    res.sendStatus(200);

    try {
      await ingestAppointment(shop, action, id);
    } catch (err) {
      logger.error({ err, shopId: shop.id, acuityId: id }, "webhook ingest failed");
    }
  },
);
