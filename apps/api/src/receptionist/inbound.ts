import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
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
 *      different shop's number IS choosing that shop). An UNKNOWN number on a
 *      shop-owned line is an SMS walk-in: a Client row is created on the spot
 *      (createSmsWalkinClient) so the AI can book them - unless the number
 *      opted out anywhere, which is always honored.
 *   1. else a live conversation for this phone wins - the thread pins the
 *      shop, so replies to a gap-fill offer route deterministically;
 *   2. else the phone must match a known Client at a receptionist-enabled
 *      native shop (multi-shop matches -> most recently visited; shops with
 *      their own number should make this guess practically unreachable);
 *   3. else NO AI - the webhook keeps today's STOP/START-only behavior.
 *      (Unknown numbers on the SHARED line are NOT onboarded: with no shop
 *      signal we can't know which shop they meant.)
 *
 * Consent semantics: replying to a consumer-initiated text needs no
 * smsConsentAt and ignores quiet hours/caps, but optedOut ALWAYS wins
 * (re-checked at send time in outbound.ts). An SMS walk-in gets NO
 * smsConsentAt - texting to book is not consent to be marketed to, so the row
 * is unreachable by nudges/gap-fill/promos until it opts in elsewhere.
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

/**
 * Ceiling on brand-new walk-in Clients minted per shop per UTC day. Bounds the
 * (signature-gated, billable) case where an attacker sends texts from many
 * rotating numbers to a shop's line and pollutes its client list. Generous
 * enough that a real busy shop never trips it. Past the ceiling, a genuinely
 * new number just gets today's shared-line behavior (no AI) until tomorrow.
 */
const WALKIN_CREATE_CAP_PER_SHOP_PER_DAY = 100;

/**
 * First text from an unknown number to a shop's OWN line = an SMS walk-in.
 * The person deliberately texted THIS shop, so replying is consumer-initiated
 * (the same TCPA basis as any inbound reply). We create a minimal Client so
 * the booking tools have an identity - but withhold smsConsentAt: that gate
 * guards PROACTIVE marketing (nudges, gap-fill, promos), and texting to book
 * is NOT consent to be blasted. source="sms_walkin" makes the origin auditable
 * and keeps them out of the "manual" dashboard badge. The AI can still learn
 * and save their first name mid-booking (tools.ts book path). Returns null if
 * the per-shop daily cap is hit, a race already created the row (caller
 * re-reads), or on any failure.
 */
async function createSmsWalkinClient(
  shopId: string,
  phone: string,
  now: Date,
): Promise<{ id: string } | null> {
  // Per-shop daily creation ceiling (anti-flood; see the constant).
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const todayCount = await prisma.client.count({
    where: { shopId, source: "sms_walkin", createdAt: { gte: dayStart } },
  });
  if (todayCount >= WALKIN_CREATE_CAP_PER_SHOP_PER_DAY) {
    logger.warn({ shopId }, "sms-walkin daily creation cap hit; no AI for new numbers today");
    return null;
  }
  try {
    return await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: phone, // normalized phone is the natural key
        phone,
        source: "sms_walkin",
        // NO smsConsentAt: conversational replies are fine, marketing is not.
        magicToken: randomToken(),
      },
      select: { id: true },
    });
  } catch (err) {
    // Unique (shopId, acuityClientKey) race: another concurrent inbound won.
    logger.info({ shopId, err: (err as Error).message }, "sms-walkin create raced/failed");
    return null;
  }
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
  //    number is choosing that shop). An UNKNOWN number that texts a shop's
  //    own line is an SMS walk-in: we create a client on the spot so the AI
  //    can book them (see createSmsWalkinClient). A number that opted out
  //    ANYWHERE is never onboarded (STOP is global and absolute).
  if (to) {
    const owned = await prisma.shop.findUnique({
      where: { twilioNumber: to },
      select: GATE_SELECT,
    });
    if (owned) {
      if (!receptionistEnabledForShop(owned, { now })) return null;
      let client = await prisma.client.findFirst({
        where: { shopId: owned.id, phone, archivedAt: null },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (!client) {
        // STOP is global: never onboard a number that opted out anywhere.
        const optedOut = await prisma.client.findFirst({
          where: { phone, optedOut: true },
          select: { id: true },
        });
        if (optedOut) return null;

        // An ARCHIVED walk-in at this shop (barber hid a past one-off) would
        // (a) be invisible to the active-only lookup above and (b) collide on
        // the (shopId, acuityClientKey=phone) unique key inside create -> the
        // number would be permanently silenced. The person is re-engaging by
        // texting the shop, so reactivate the row instead. Match on the
        // walk-in's natural key (acuityClientKey=phone) so we never resurrect
        // some unrelated archived record.
        const archived = await prisma.client.findFirst({
          where: { shopId: owned.id, acuityClientKey: phone, archivedAt: { not: null } },
          select: { id: true },
        });
        if (archived) {
          await prisma.client.update({
            where: { id: archived.id },
            data: { archivedAt: null },
          });
          client = archived;
        } else {
          client =
            (await createSmsWalkinClient(owned.id, phone, now)) ??
            // Lost the create race -> the winner's row now exists; re-read it.
            // (Also the null-on-cap path: no row to find, so we stay silent.)
            (await prisma.client.findFirst({
              where: { shopId: owned.id, phone, archivedAt: null },
              orderBy: { createdAt: "desc" },
              select: { id: true },
            }));
        }
        if (!client) return null;
      }
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
