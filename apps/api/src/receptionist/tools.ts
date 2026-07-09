import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { apiEnv, zonedWallTimeToUtc } from "@chairback/config";
import { forShop, prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { computeOpenSlots, type Slot } from "../engines/slots.js";
import { formatApptTime } from "../messaging/templates.js";
import { sendPushToUser } from "../messaging/push.js";
import { getMessageProvider } from "../messaging/twilio.js";
import type { ToolExecutionResult, ToolExecutor } from "./agent.js";

/**
 * The receptionist's tools: the ONLY way the model touches the calendar. Names
 * and behaviors match what ai/receptionist-prompt.md references. Every input is
 * zod-validated (the model's output is untrusted), and client identity always
 * comes from the DB-resolved conversation context - never from model text (a
 * texter can claim to be anyone; prompt-injection surface).
 *
 * All results are JSON strings; failures return isError=true tool_results so
 * the model can recover in-conversation instead of the process throwing.
 */

export interface ToolContext {
  shopId: string;
  conversationId: string;
  /** The texter's E.164 number - the trusted identity for this thread. */
  phone: string;
  /** Resolved Client row id, when the phone matches one. */
  clientId: string | null;
  now: Date;
}

/** Soft-lock TTL while a client decides ("want Thu 2:30?"). */
export const CONVERSATIONAL_HOLD_TTL_MS = 10 * 60 * 1000;
/** Longer TTL for proactive gap-fill offers (a human may take a while to reply). */
export const GAPFILL_HOLD_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tool definitions (the schema the model sees)
// ---------------------------------------------------------------------------

export const RECEPTIONIST_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "check_availability",
    description:
      "Look up REAL open appointment slots. Call this before offering ANY time - " +
      "never invent a slot. Returns bookable slots (each with a slot_id) per barber " +
      "for the requested service and date range, in the shop's timezone.",
    input_schema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "Service name from the menu, e.g. 'Cut' or 'skin fade'",
        },
        from_date: {
          type: "string",
          description: "First date to check, YYYY-MM-DD in the shop's timezone",
        },
        to_date: {
          type: "string",
          description:
            "Last date to check (inclusive), YYYY-MM-DD. Omit to check just from_date.",
        },
        barber: {
          type: "string",
          description: "Barber name, when the client asked for someone specific",
        },
      },
      required: ["service", "from_date"],
    },
  },
  {
    name: "hold_slot",
    description:
      "Soft-lock a slot you are about to offer (or just offered) so it can't get " +
      "double-booked while the client decides. Use a slot_id returned by " +
      "check_availability. Holds expire on their own after a few minutes.",
    input_schema: {
      type: "object",
      properties: {
        slot_id: { type: "string", description: "slot_id from check_availability" },
      },
      required: ["slot_id"],
    },
  },
  {
    name: "book_appointment",
    description:
      "Write the booking for a slot you hold. Availability is re-verified at write " +
      "time; if the slot was lost you'll get an error - apologize once and offer the " +
      "next-closest times. Always confirm date + time + service with the client first.",
    input_schema: {
      type: "object",
      properties: {
        slot_id: { type: "string", description: "the held slot's slot_id" },
        client_name: {
          type: "string",
          description:
            "First name for the booking, only when the client is new/unknown and told you their name",
        },
      },
      required: ["slot_id"],
    },
  },
  {
    name: "reschedule",
    description:
      "Move an existing appointment to a new slot. appointment_id comes from " +
      "get_client_history; new_slot_id from check_availability.",
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "string" },
        new_slot_id: { type: "string" },
      },
      required: ["appointment_id", "new_slot_id"],
    },
  },
  {
    name: "cancel",
    description:
      "Cancel an existing appointment (appointment_id from get_client_history). " +
      "Confirm with the client before calling this.",
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "string" },
      },
      required: ["appointment_id"],
    },
  },
  {
    name: "get_client_history",
    description:
      "Who is this texter? Past visits, usual service, loyalty status, last visit, " +
      "and their upcoming appointments (with appointment_ids for reschedule/cancel). " +
      "Call this early on inbound so a returning client feels remembered.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand this thread to the barber with the full transcript. Use for upset " +
      "clients, complaints, refunds/money disputes, requests outside the menu or " +
      "tools, or when intent stays unclear after one clarifying question. After " +
      "calling this, send one short handoff line and stop.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "one line on why you're escalating" },
      },
      required: ["reason"],
    },
  },
];

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const checkAvailabilityInput = z.object({
  service: z.string().min(1),
  from_date: z.string().regex(DATE_RE),
  to_date: z.string().regex(DATE_RE).optional(),
  barber: z.string().min(1).optional(),
});

const escalateInput = z.object({ reason: z.string().min(1) });

// ---------------------------------------------------------------------------
// slot_id codec - the opaque handle the model passes between tools
// ---------------------------------------------------------------------------

export function encodeSlotId(staffId: string, serviceId: string, startsAt: Date): string {
  return `${staffId}~${serviceId}~${startsAt.toISOString()}`;
}

export function decodeSlotId(
  slotId: string,
): { staffId: string; serviceId: string; startsAt: Date } | null {
  const parts = slotId.split("~");
  if (parts.length !== 3) return null;
  const startsAt = new Date(parts[2]!);
  if (Number.isNaN(startsAt.getTime())) return null;
  return { staffId: parts[0]!, serviceId: parts[1]!, startsAt };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(payload: unknown): ToolExecutionResult {
  return { result: JSON.stringify(payload), isError: false };
}

function fail(message: string): ToolExecutionResult {
  return { result: message, isError: true };
}

/** "2026-07-10" -> {year, month0, day}; already regex-validated. */
function parseYmd(s: string): { year: number; month0: number; day: number } {
  const [y, m, d] = s.split("-").map(Number);
  return { year: y!, month0: m! - 1, day: d! };
}

/** Case-insensitive service match: exact name first, then contains. */
async function resolveService(
  shopId: string,
  name: string,
): Promise<{ id: string; name: string; durationMin: number } | null> {
  const db = forShop(shopId);
  const services = await db.service.findMany({
    where: { active: true },
    select: { id: true, name: true, durationMin: true },
  });
  const q = name.trim().toLowerCase();
  return (
    services.find((s) => s.name.toLowerCase() === q) ??
    services.find(
      (s) => s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase()),
    ) ??
    null
  );
}

/**
 * Pick a small, useful spread of slots per local day (open, midday, late) so
 * the model can offer 2-3 specific times without wading through a wall of them.
 */
export function spreadSlots(slots: Slot[], timezone: string, perDay = 3): Slot[] {
  const byDay = new Map<string, Slot[]>();
  const dayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  for (const s of slots) {
    const key = dayKey.format(s.startsAt);
    const list = byDay.get(key) ?? [];
    list.push(s);
    byDay.set(key, list);
  }
  const out: Slot[] = [];
  for (const list of byDay.values()) {
    list.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    if (list.length <= perDay) {
      out.push(...list);
    } else {
      out.push(list[0]!, list[Math.floor(list.length / 2)]!, list[list.length - 1]!);
    }
  }
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

// ---------------------------------------------------------------------------
// Tool implementations (Phase 1: read-only + escalate; writes land in Phase 2/3)
// ---------------------------------------------------------------------------

async function checkAvailability(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolExecutionResult> {
  const parsed = checkAvailabilityInput.safeParse(rawInput);
  if (!parsed.success) return fail(`invalid input: ${parsed.error.issues[0]?.message}`);
  const input = parsed.data;

  const shop = await prisma.shop.findUnique({
    where: { id: ctx.shopId },
    select: { timezone: true },
  });
  if (!shop) return fail("shop not found");

  const service = await resolveService(ctx.shopId, input.service);
  if (!service) {
    return fail(
      `no service matching "${input.service}" on the menu - if the client wants ` +
        "something we don't list, check with the barber (escalate_to_human)",
    );
  }

  // Which barbers to check: the named one, or everyone offering the service.
  const db = forShop(ctx.shopId);
  const offering = await db.serviceStaff.findMany({
    where: { serviceId: service.id },
  });
  const offeringIds = new Set(offering.map((o) => o.staffId));
  const allStaff = await db.staff.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  let staff = allStaff.filter((s) => offeringIds.has(s.id));
  if (input.barber) {
    const q = input.barber.trim().toLowerCase();
    const matched = staff.filter((s) => s.name.toLowerCase().includes(q));
    if (matched.length === 0) {
      return fail(
        `no barber matching "${input.barber}" offers ${service.name}. ` +
          `Available: ${staff.map((s) => s.name).join(", ") || "none"}`,
      );
    }
    staff = matched;
  }
  if (staff.length === 0) return fail(`nobody currently offers ${service.name}`);

  const from = parseYmd(input.from_date);
  const to = parseYmd(input.to_date ?? input.from_date);
  const fromDate = zonedWallTimeToUtc(from.year, from.month0, from.day, 0, shop.timezone);
  const toDate = zonedWallTimeToUtc(to.year, to.month0, to.day, 1439, shop.timezone);
  if (toDate.getTime() <= ctx.now.getTime()) {
    return fail("that date range is entirely in the past");
  }

  const perStaff: { barber: string; slots: { slot_id: string; label: string }[] }[] = [];
  for (const member of staff.slice(0, 3)) {
    const slots = await computeOpenSlots({
      shopId: ctx.shopId,
      staffId: member.id,
      serviceId: service.id,
      fromDate,
      toDate,
      now: ctx.now,
    });
    const picked = spreadSlots(slots, shop.timezone);
    perStaff.push({
      barber: member.name,
      slots: picked.map((s) => ({
        slot_id: encodeSlotId(member.id, service.id, s.startsAt),
        label: formatApptTime(s.startsAt, shop.timezone),
      })),
    });
  }

  const total = perStaff.reduce((n, s) => n + s.slots.length, 0);
  return ok({
    service: service.name,
    duration_min: service.durationMin,
    timezone: shop.timezone,
    availability: perStaff,
    note:
      total === 0
        ? "nothing open in that range - try nearby dates or offer the waitlist"
        : "offer 2-3 of these; hold_slot the ones you offer",
  });
}

async function getClientHistory(ctx: ToolContext): Promise<ToolExecutionResult> {
  if (!ctx.clientId) {
    return ok({
      known: false,
      note: "new/unknown number - ask for a first name before booking",
    });
  }
  const db = forShop(ctx.shopId);
  const client = await db.client.findFirst({
    where: { id: ctx.clientId },
    select: {
      firstName: true,
      lastName: true,
      lastVisitAt: true,
      medianIntervalDays: true,
      loyaltyTier: true,
      optedOut: true,
    },
  });
  if (!client) return ok({ known: false });

  const shop = await prisma.shop.findUnique({
    where: { id: ctx.shopId },
    select: { timezone: true },
  });
  const tz = shop?.timezone ?? "America/New_York";

  const [visits, punchAgg, upcoming] = await Promise.all([
    db.visit.findMany({
      where: { clientId: ctx.clientId, status: "COMPLETED" },
      orderBy: { scheduledAt: "desc" },
      take: 10,
      select: { scheduledAt: true, serviceName: true },
    }),
    runWithShop(ctx.shopId, (tx) =>
      tx.punchLedger.aggregate({
        where: { clientId: ctx.clientId! },
        _sum: { punchesEarned: true, punchesRedeemed: true },
      }),
    ),
    runWithShop(ctx.shopId, (tx) =>
      tx.appointment.findMany({
        where: {
          clientId: ctx.clientId!,
          status: { in: ["BOOKED", "PENDING"] },
          startsAt: { gt: ctx.now },
          holdExpiresAt: null, // receptionist holds are not real bookings
        },
        orderBy: { startsAt: "asc" },
        take: 5,
        select: {
          id: true,
          status: true,
          startsAt: true,
          service: { select: { name: true } },
          staff: { select: { name: true } },
        },
      }),
    ),
  ]);

  // "Usual" = most frequent service across the recent completed visits.
  const counts = new Map<string, number>();
  for (const v of visits) {
    if (v.serviceName) counts.set(v.serviceName, (counts.get(v.serviceName) ?? 0) + 1);
  }
  const usualService =
    [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const punchBalance =
    (punchAgg._sum.punchesEarned ?? 0) - (punchAgg._sum.punchesRedeemed ?? 0);

  return ok({
    known: true,
    first_name: client.firstName,
    last_name: client.lastName,
    usual_service: usualService,
    last_visit: client.lastVisitAt ? formatApptTime(client.lastVisitAt, tz) : null,
    typical_weeks_between_visits: client.medianIntervalDays
      ? Math.round(client.medianIntervalDays / 7)
      : null,
    loyalty_tier: client.loyaltyTier,
    punch_balance: punchBalance,
    opted_out_of_texts: client.optedOut,
    recent_visits: visits.slice(0, 5).map((v) => ({
      when: formatApptTime(v.scheduledAt, tz),
      service: v.serviceName,
    })),
    upcoming_appointments: upcoming.map((a) => ({
      appointment_id: a.id,
      status: a.status,
      when: formatApptTime(a.startsAt, tz),
      service: a.service.name,
      barber: a.staff.name,
    })),
  });
}

async function escalateToHuman(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolExecutionResult> {
  const parsed = escalateInput.safeParse(rawInput);
  const reason = parsed.success ? parsed.data.reason : "unspecified";
  await escalateConversation({
    shopId: ctx.shopId,
    conversationId: ctx.conversationId,
    phone: ctx.phone,
    reason,
  });
  return ok({
    escalated: true,
    note: "the barber has the thread - send one short handoff line and stop",
  });
}

/**
 * Hand a thread to the barber: flip the conversation to `escalated` (the AI
 * goes silent on it), drop an audit note, and alert the barber by push + SMS
 * (same transports as the slot-opened alert). Never throws.
 */
export async function escalateConversation(params: {
  shopId: string;
  conversationId: string;
  phone: string;
  reason: string;
}): Promise<void> {
  try {
    await prisma.receptionistConversation.update({
      where: { id: params.conversationId },
      data: { status: "escalated" },
    });
    await prisma.receptionistMessage.create({
      data: {
        shopId: params.shopId,
        conversationId: params.conversationId,
        role: "system_note",
        content: `escalated to barber: ${params.reason}`,
      },
    });

    const shop = await prisma.shop.findUnique({
      where: { id: params.shopId },
      select: { id: true, name: true, ownerId: true, notifyPhone: true },
    });
    if (!shop) return;

    const title = "Client needs you";
    const body = `${shop.name}: the AI receptionist handed off a text thread with ${params.phone} - ${params.reason}`;
    await sendPushToUser({
      userId: shop.ownerId,
      shopId: shop.id,
      payload: {
        title,
        body,
        url: `${apiEnv().APP_BASE_URL}/dashboard`,
        tag: "receptionist-escalation",
      },
    }).catch((err) =>
      logger.error({ err, shopId: shop.id }, "escalation push failed"),
    );

    if (shop.notifyPhone) {
      if (apiEnv().DRY_RUN) {
        logger.info(
          { shopId: shop.id, to: shop.notifyPhone },
          "escalation barber SMS (dry-run, not sent)",
        );
      } else {
        await getMessageProvider()
          .send({ to: shop.notifyPhone, body })
          .catch((err) =>
            logger.error({ err, shopId: shop.id }, "escalation barber SMS failed"),
          );
      }
    }
  } catch (err) {
    logger.error(
      { err, conversationId: params.conversationId },
      "escalateConversation failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const NOT_YET_ENABLED =
  "this action isn't enabled for this shop yet - apologize briefly and use " +
  "escalate_to_human so the barber can handle it directly";

/** Bind a ToolExecutor to one conversation's context. */
export function makeToolExecutor(ctx: ToolContext): ToolExecutor {
  return async (name, input) => {
    try {
      switch (name) {
        case "check_availability":
          return await checkAvailability(ctx, input);
        case "get_client_history":
          return await getClientHistory(ctx);
        case "escalate_to_human":
          return await escalateToHuman(ctx, input);
        // Booking writes land in Phase 2/3; keep the model on a graceful path.
        case "hold_slot":
        case "book_appointment":
        case "reschedule":
        case "cancel":
          return fail(NOT_YET_ENABLED);
        default:
          return fail(`unknown tool: ${name}`);
      }
    } catch (err) {
      logger.error({ err, tool: name, shopId: ctx.shopId }, "receptionist tool failed");
      return fail("internal error running this tool - consider escalate_to_human");
    }
  };
}
