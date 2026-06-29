import express, { Router } from "express";
import twilio from "twilio";
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { toE164 } from "../acuity/clientKey.js";
import { logger } from "../logger.js";

const env = apiEnv();

/**
 * Twilio inbound webhook for STOP handling. On a stop keyword we set optedOut on
 * every client matching the sender's phone (shared number -> opt out all matches,
 * the safe choice). Validates the Twilio signature.
 */
export const twilioWebhookRouter: Router = Router();

const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_WORDS = new Set(["START", "YES", "UNSTOP"]);

twilioWebhookRouter.post(
  "/inbound",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    // Validate the request came from Twilio.
    const signature = req.header("X-Twilio-Signature") ?? "";
    const url = `${env.API_BASE_URL}/webhooks/twilio/inbound`;
    const valid = twilio.validateRequest(
      env.TWILIO_AUTH_TOKEN,
      signature,
      url,
      req.body as Record<string, string>,
    );
    // Enforce ALWAYS (not just production): this endpoint can opt clients out of
    // SMS, and NODE_ENV defaults to "development" - a missing env var must not
    // silently disable the only authentication this route has. Tests are the
    // single explicit bypass.
    if (!valid && process.env.VITEST !== "true") {
      res.sendStatus(403);
      return;
    }

    const from = toE164((req.body as { From?: string }).From);
    const text = ((req.body as { Body?: string }).Body ?? "").trim().toUpperCase();

    // Opt-in confirmation copy (matches the A2P campaign's registered opt-in
    // message). Sent ONLY on START/YES/UNSTOP - carriers (esp. T-Mobile) send
    // their own mandatory auto-reply for STOP and HELP and may filter a second
    // app-sent reply, so we leave those to the carrier and never double-text.
    const OPT_IN_REPLY =
      "ChairBack: You're opted in to appointment reminders and rewards updates " +
      "from your shop. Msg & data rates may apply. Reply HELP for help, STOP to opt out.";

    let reply = "";
    if (from && STOP_WORDS.has(text)) {
      const { count } = await prisma.client.updateMany({
        where: { phone: from },
        data: { optedOut: true },
      });
      logger.info({ from, count }, "twilio STOP - opted out");
      // No app reply: the carrier auto-sends the mandatory opt-out confirmation.
    } else if (from && START_WORDS.has(text)) {
      const { count } = await prisma.client.updateMany({
        where: { phone: from },
        data: { optedOut: false },
      });
      logger.info({ from, count }, "twilio START - opted in");
      // Confirm the opt-in (carriers do NOT auto-reply to START).
      if (count > 0) reply = OPT_IN_REPLY;
    }

    // Escape the body for XML (the copy is static + safe, but keep it correct
    // if it ever changes). Empty reply => empty TwiML (no message sent).
    const xml = reply
      ? `<Response><Message>${reply
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}</Message></Response>`
      : "<Response></Response>";
    res.type("text/xml").send(xml);
  },
);
