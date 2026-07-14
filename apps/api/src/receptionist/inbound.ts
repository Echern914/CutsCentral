import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { receptionistEnabledForShop, receptionistConfigured } from "./config.js";
import { renderPromptForShop } from "./prompt.js";
import { runAgentTurn } from "./agent.js";
import {
  RECEPTIONIST_TOOLS,
  describeActiveHolds,
  describeUpcomingAppointments,
  escalateConversation,
  makeToolExecutor,
} from "./tools.js";
import {
  appendMessage,
  buildHistory,
  claimTurn,
  findOrCreateConversation,
  releaseTurn,
  type ConversationRow,
} from "./conversation.js";
import { sendReceptionistSms } from "./outbound.js";
import { receptionistReplyCapReason } from "./replyCap.js";

/**
 * Inbound orchestration: a non-keyword text arrives on the SHARED platform
 * number and (maybe) becomes an AI turn.
 *
 * Shop routing, in precedence order:
 *   0. the number the client TEXTED is a shop-owned line (Shop.twilioNumber)
 *      -> that shop, full stop. The structural fix for wrong-shop routing:
 *      no guessing, and it outranks a live thread at another shop (texting a
 *      different shop's number IS choosing that shop).
 *   1. else a live conversation for this phone wins - the thread pins the
 *      shop, so replies to a gap-fill offer route deterministically;
 *   2. else the phone must match a known Client at a receptionist-enabled
 *      native shop (multi-shop matches -> most recently visited; shops with
 *      their own number should make this guess practically unreachable);
 *   3. else NO AI - the webhook keeps today's STOP/START-only behavior.
 *
 * Consent semantics: replying to a consumer-initiated text needs no
 * smsConsentAt and ignores quiet hours/caps, but optedOut ALWAYS wins
 * (re-checked at send time in outbound.ts).
 */

const GATE_SELECT = {
  id: true,
  name: true,
  timezone: true,
  bookingMode: true,
  plan: true,
  receptionistEnabled: true,
  receptionistSubscriptionStatus: true,
  receptionistCompAccess: true,
  receptionistTermsAcceptedAt: true,
  subscriptionStatus: true,
  trialEndsAt: true,
  compAccess: true,
  twilioNumber: true,
} as const;

type GateShop = {
  id: string;
  name: string;
  timezone: string;
  bookingMode: string;
  plan: string;
  receptionistEnabled: boolean;
  receptionistSubscriptionStatus: string;
  receptionistCompAccess: boolean;
  receptionistTermsAcceptedAt: Date | null;
  subscriptionStatus: string;
  trialEndsAt: Date | null;
  compAccess: boolean;
  twilioNumber: string | null;
};

interface ResolvedInbound {
  shop: GateShop;
  clientId: string | null;
  conversation: ConversationRow;
}

/** Which shop (if any) should answer this phone number right now. */
async function resolveInbound(
  phone: string,
  now: Date,
  to?: string | null,
): Promise<ResolvedInbound | null> {
  // 0. A shop-owned line: the number the client TEXTED is the shop - the
  //    structural fix for wrong-shop routing. It outranks everything,
  //    including a live thread at another shop (texting a different shop's
  //    number is choosing that shop). Unknown texters on a shop line stay
  //    silent for now (booking tools need a Client identity), same as the
  //    shared line.
  if (to) {
    const owned = await prisma.shop.findUnique({
      where: { twilioNumber: to },
      select: GATE_SELECT,
    });
    if (owned) {
      if (!receptionistEnabledForShop(owned, { now })) return null;
      const client = await prisma.client.findFirst({
        where: { shopId: owned.id, phone, archivedAt: null },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (!client) return null;
      const conversation = await findOrCreateConversation({
        shopId: owned.id,
        phone,
        clientId: client.id,
      });
      return { shop: owned, clientId: client.id, conversation };
    }
  }

  // 1. Live thread wins (routing must stay stable mid-conversation).
  const live = await prisma.receptionistConversation.findFirst({
    where: { phone, status: { in: ["active", "escalated"] } },
    orderBy: { lastMessageAt: "desc" },
    select: {
      id: true,
      shopId: true,
      clientId: true,
      phone: true,
      status: true,
      shop: { select: GATE_SELECT },
    },
  });
  if (live) {
    if (!receptionistEnabledForShop(live.shop, { now })) return null;
    return {
      shop: live.shop,
      clientId: live.clientId,
      conversation: {
        id: live.id,
        shopId: live.shopId,
        clientId: live.clientId,
        phone: live.phone,
        status: live.status,
      },
    };
  }

  // 2. Known client at an enabled shop; most recently visited match wins.
  const matches = await prisma.client.findMany({
    where: { phone, archivedAt: null },
    select: {
      id: true,
      shopId: true,
      lastVisitAt: true,
      createdAt: true,
      shop: { select: GATE_SELECT },
    },
  });
  const eligible = matches.filter((m) => receptionistEnabledForShop(m.shop, { now }));
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    const av = a.lastVisitAt?.getTime() ?? 0;
    const bv = b.lastVisitAt?.getTime() ?? 0;
    if (av !== bv) return bv - av; // most recent visit first; never-visited last
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  const winner = eligible[0]!;
  const conversation = await findOrCreateConversation({
    shopId: winner.shopId,
    phone,
    clientId: winner.id,
  });
  return { shop: winner.shop, clientId: winner.id, conversation };
}

/** The volatile per-turn context (kept OUT of the cached system prompt). */
function buildContextTurn(
  shop: GateShop,
  phone: string,
  now: Date,
  holdsNote: string | null,
  apptsNote: string | null,
): string {
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: shop.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(now);
  let out =
    `[context - not from the client] Current date/time at the shop: ${local} ` +
    `(${shop.timezone}). You are texting with ${phone} over SMS. Use ` +
    `get_client_history to see who they are. Dates you pass to tools are ` +
    `YYYY-MM-DD in the shop's timezone.`;
  if (apptsNote) {
    out +=
      `\nThis client's upcoming appointments - to move one use ` +
      `reschedule(appointment_id, new_slot_id); NEVER book a second ` +
      `appointment when they asked to move:\n${apptsNote}`;
  }
  if (holdsNote) {
    out +=
      `\nSlots you currently HOLD for this client - these do NOT appear in ` +
      `check_availability while held. When the client accepts one, call ` +
      `book_appointment (or reschedule) with its slot_id directly; do NOT ` +
      `re-check availability first:\n${holdsNote}`;
  }
  return out;
}

/** Fallback line when a turn dies and the barber has to take over. */
const HANDOFF_LINE =
  "let me get the barber on this one - someone will text you back shortly";

/** True when an active receptionist thread exists for this phone (webhook YES routing). */
export async function hasLiveConversation(phone: string): Promise<boolean> {
  if (!receptionistConfigured()) return false;
  const live = await prisma.receptionistConversation.findFirst({
    where: { phone, status: "active" },
    select: { id: true },
  });
  return live !== null;
}

/**
 * Handle one inbound text end-to-end. Fired AFTER the webhook has ACKed Twilio
 * (LLM latency vs the 15s webhook timeout) - the reply goes out via the REST
 * send path, not TwiML. Never throws.
 */
export async function processInboundText(params: {
  phone: string;
  text: string;
  /** The number the client texted (E.164) - pins the shop when a shop owns it. */
  to?: string | null;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  try {
    if (!receptionistConfigured()) return;
    const resolved = await resolveInbound(params.phone, now, params.to);
    if (!resolved) return; // unknown number / no enabled shop -> no AI (v1)

    const { shop, conversation } = resolved;

    // Always persist the inbound text - it's the audit trail even when the AI
    // stays silent (escalated thread, lost claim race).
    await appendMessage({
      shopId: shop.id,
      conversationId: conversation.id,
      role: "user",
      content: params.text,
    });

    // Escalated = the barber owns this thread; the AI stays silent.
    if (conversation.status === "escalated") return;

    // clientId can be null on a thread whose client was merged/archived
    // mid-conversation; the Nudge ledger needs one, so re-resolve or stop.
    let clientId = conversation.clientId;
    if (!clientId) {
      const client = await prisma.client.findFirst({
        where: { shopId: shop.id, phone: params.phone, archivedAt: null },
        select: { id: true },
      });
      clientId = client?.id ?? null;
    }
    if (!clientId) {
      logger.warn(
        { conversationId: conversation.id },
        "receptionist: no client for thread; staying silent",
      );
      return;
    }

    // Abuse guard BEFORE claiming the turn: a capped inbound skips the
    // Anthropic call entirely, not just the SMS. See replyCap.ts.
    const capReason = await receptionistReplyCapReason(shop.id, clientId, now);
    if (capReason === "shop_daily_cap") {
      // Distributed flood: AI goes quiet shop-wide until tomorrow. No
      // escalation (that would page the barber once per thread) and no SMS.
      logger.warn(
        { shopId: shop.id, conversationId: conversation.id },
        "receptionist: shop daily reply cap hit; staying silent",
      );
      return;
    }
    if (capReason === "client_daily_cap") {
      // Single number hammering the line: hand the thread to the barber
      // (escalated status silences all future AI turns at zero cost) and send
      // NO reply - a "you hit the limit" text would itself be a reply the
      // abuser keeps triggering. escalateConversation records the system note
      // and alerts the barber so a legitimate chatty client isn't ghosted.
      logger.warn(
        { shopId: shop.id, conversationId: conversation.id, clientId },
        "receptionist: per-client daily reply cap hit; escalating",
      );
      await escalateConversation({
        shopId: shop.id,
        conversationId: conversation.id,
        phone: params.phone,
        reason: "reply_cap",
      });
      return;
    }

    if (!(await claimTurn(conversation.id, now))) return; // racer persisted; done

    try {
      const system = await renderPromptForShop(shop.id);
      if (!system) return; // prompt file missing -> feature off

      const [holdsNote, apptsNote] = await Promise.all([
        describeActiveHolds({ shopId: shop.id, clientId, timezone: shop.timezone, now }),
        describeUpcomingAppointments({
          shopId: shop.id,
          clientId,
          timezone: shop.timezone,
          now,
        }),
      ]);
      const history = await buildHistory(conversation.id);
      const messages = [
        {
          role: "user" as const,
          content: buildContextTurn(shop, params.phone, now, holdsNote, apptsNote),
        },
        ...history,
      ];

      const executor = makeToolExecutor({
        shopId: shop.id,
        conversationId: conversation.id,
        phone: params.phone,
        clientId,
        now,
      });

      const outcome = await runAgentTurn({
        system,
        messages,
        tools: RECEPTIONIST_TOOLS,
        executeTool: executor,
      });

      if (outcome.kind === "reply") {
        await appendMessage({
          shopId: shop.id,
          conversationId: conversation.id,
          role: "assistant",
          content: outcome.text,
          toolCalls: outcome.toolCalls,
        });
        await sendReceptionistSms({
          shopId: shop.id,
          clientId,
          phone: params.phone,
          body: outcome.text,
          kind: "receptionist_reply",
          from: shop.twilioNumber,
        });
      } else {
        // The loop died (API error, refusal, runaway) - hand off gracefully.
        await escalateConversation({
          shopId: shop.id,
          conversationId: conversation.id,
          phone: params.phone,
          reason: outcome.reason,
        });
        await appendMessage({
          shopId: shop.id,
          conversationId: conversation.id,
          role: "assistant",
          content: HANDOFF_LINE,
          toolCalls: outcome.toolCalls,
        });
        await sendReceptionistSms({
          shopId: shop.id,
          clientId,
          phone: params.phone,
          body: HANDOFF_LINE,
          kind: "receptionist_reply",
          from: shop.twilioNumber,
        });
      }
    } finally {
      await releaseTurn(conversation.id);
    }
  } catch (err) {
    logger.error({ err, phone: params.phone }, "processInboundText failed");
  }
}
