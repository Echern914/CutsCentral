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
 * We ingest FIRST and only then ack 200. If ingest fails we return 500 so
 * Acuity retries the delivery - an early 200 would tell Acuity "done" and the
 * appointment (and its punch) would be silently lost forever. Ingest is
 * idempotent via unique constraints, so retries never duplicate.
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

    try {
      await ingestAppointment(shop, action, id);
      res.sendStatus(200);
    } catch (err) {
      logger.error({ err, shopId: shop.id, acuityId: id }, "webhook ingest failed");
      // 5xx -> Acuity re-delivers; the idempotent ingest absorbs the retry.
      res.sendStatus(500);
    }
  },
);
