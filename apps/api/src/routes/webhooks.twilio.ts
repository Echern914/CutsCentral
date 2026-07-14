import express, { Router } from "express";
import twilio from "twilio";
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { toE164 } from "../acuity/clientKey.js";
import { logger } from "../logger.js";
import { closeConversationsForPhone } from "../receptionist/conversation.js";
import { hasLiveConversation, processInboundText } from "../receptionist/inbound.js";

const env = apiEnv();

/**
 * Twilio inbound webhook. Compliance keywords (STOP/START) are handled FIRST
 * and synchronously, exactly as before; any other text is offered to the AI
 * receptionist, which runs AFTER the TwiML ACK (LLM latency vs Twilio's ~15s
 * webhook timeout) and replies via the REST send path. Numbers that don't
 * resolve to a receptionist-enabled shop keep today's behavior: no reply.
 * Validates the Twilio signature.
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
    // The number the client texted. On a shop-owned line (Shop.twilioNumber)
    // this pins receptionist routing to that shop - no phone-match guessing.
    const to = toE164((req.body as { To?: string }).To);
    const text = ((req.body as { Body?: string }).Body ?? "").trim().toUpperCase();

    // Opt-in confirmation copy (matches the A2P campaign's registered opt-in
    // message). Sent ONLY on START/YES/UNSTOP - carriers (esp. T-Mobile) send
    // their own mandatory auto-reply for STOP and HELP and may filter a second
    // app-sent reply, so we leave those to the carrier and never double-text.
    const OPT_IN_REPLY =
      "ChairBack: You're opted in to appointment reminders and rewards updates " +
      "from your shop. Msg & data rates may apply. Reply HELP for help, STOP to opt out.";

    // "YES" is BOTH an opt-in keyword and the most natural way to accept a
    // booking offer ("want Thu 2:30?" -> "yes"). Inside a live receptionist
    // thread it means the booking; standalone it keeps its opt-in meaning.
    // STOP words and START/UNSTOP are absolute either way (carrier compliance).
    const yesInConversation =
      text === "YES" && from !== null && (await hasLiveConversation(from));

    let reply = "";
    if (from && STOP_WORDS.has(text)) {
      // "sms_stop" locks the row: only the client can reverse it (START here,
      // or their rewards page) - never the dashboard.
      const { count } = await prisma.client.updateMany({
        where: { phone: from },
        data: { optedOut: true, optOutSource: "sms_stop" },
      });
      // The AI goes silent on every live thread for this number, immediately.
      const closed = await closeConversationsForPhone(from).catch(() => 0);
      logger.info({ from, count, closedConversations: closed }, "twilio STOP - opted out");
      // No app reply: the carrier auto-sends the mandatory opt-out confirmation.
    } else if (from && START_WORDS.has(text) && !yesInConversation) {
      const { count } = await prisma.client.updateMany({
        where: { phone: from },
        data: { optedOut: false, optOutSource: null },
      });
      logger.info({ from, count }, "twilio START - opted in");
      // Confirm the opt-in (carriers do NOT auto-reply to START).
      if (count > 0) reply = OPT_IN_REPLY;
    } else if (from) {
      // Not a compliance keyword: offer it to the AI receptionist. Fire and
      // forget AFTER we ACK - the reply (if any) goes out via REST, not TwiML.
      const rawBody = ((req.body as { Body?: string }).Body ?? "").trim();
      if (rawBody) void processInboundText({ phone: from, text: rawBody, to });
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
