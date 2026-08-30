import express, { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "../logger.js";
import { applyEmailEvent } from "../services/emailDelivery.js";

/**
 * Resend delivery webhooks - the missing half of email observability.
 *
 * Without this, a send was fire-and-forget: the message id was logged and
 * discarded, and bounces, spam complaints and deferrals never reached the
 * application at all. "My customers aren't getting the emails" had no
 * evidence behind it either way.
 *
 * Resend signs with Svix. The signed payload is `${id}.${timestamp}.${body}`,
 * HMAC-SHA256 under the base64 secret (the part after "whsec_"), and the
 * svix-signature header carries one or more space-separated `v1,<base64>`
 * entries - more than one during a secret rotation, so ANY match counts.
 *
 * 🔴 The raw body must be the EXACT bytes Resend signed, hence express.raw.
 * 🔴 Nothing from the payload is logged: it carries the recipient address and
 * the rendered subject. Only the event name and a fixed outcome go to the log.
 */
export const resendWebhookRouter: Router = Router();

/** Tolerate ±5 minutes of clock skew; older is a replay. */
const TOLERANCE_S = 5 * 60;

export function verifySvixSignature(params: {
  secret: string;
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  body: Buffer;
  now?: Date;
}): boolean {
  const { secret, id, timestamp, signature, body } = params;
  if (!id || !timestamp || !signature) return false;

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const nowS = Math.floor((params.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowS - ts) > TOLERANCE_S) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest("base64");

  // The header may list several versioned signatures during a rotation.
  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) continue;
    const a = Buffer.from(value);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

resendWebhookRouter.post("/", express.raw({ type: "*/*" }), async (req, res) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  // Refuse rather than trust an unsigned payload - the same posture as the
  // Square receiver. An unconfigured webhook is a 401, not an open door.
  if (!secret) {
    logger.error("resend webhook received but RESEND_WEBHOOK_SECRET unset - rejecting");
    res.sendStatus(401);
    return;
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (
    !verifySvixSignature({
      secret,
      id: req.header("svix-id"),
      timestamp: req.header("svix-timestamp"),
      signature: req.header("svix-signature"),
      body: raw,
    })
  ) {
    logger.warn("resend webhook bad signature");
    res.sendStatus(401);
    return;
  }

  let event: string | undefined;
  let messageId: string | undefined;
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as {
      type?: unknown;
      data?: { email_id?: unknown };
    };
    if (typeof parsed.type === "string") event = parsed.type;
    if (typeof parsed.data?.email_id === "string") messageId = parsed.data.email_id;
  } catch {
    // Malformed body from a correctly-signed sender: ack so it is not retried
    // forever, and say so with a fixed classification.
    logger.warn({ reason: "unparseable_body" }, "resend webhook ignored");
    res.json({ ok: true });
    return;
  }

  if (!event || !messageId) {
    logger.warn({ reason: "missing_fields" }, "resend webhook ignored");
    res.json({ ok: true });
    return;
  }

  // The svix delivery id is the REPLAY key: svix retries on any non-2xx and
  // can redeliver a success too, so applying an event must be keyed on the
  // delivery, not merely on the message.
  const outcome = await applyEmailEvent({
    messageId,
    event,
    svixId: req.header("svix-id"),
  });
  // Event name and outcome only - never the payload, which carries the
  // recipient address and the rendered subject.
  logger.info({ event, outcome }, "resend delivery event");
  // Always 200 on a verified event: a 5xx makes Resend retry, and applying an
  // event is idempotent, so a retry buys nothing but noise.
  res.json({ ok: true });
});
