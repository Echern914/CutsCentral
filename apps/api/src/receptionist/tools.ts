import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { apiEnv, randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { forShop, prisma, Prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { computeOpenSlots, isSlotBookable, type Slot } from "../engines/slots.js";
import { lockStaffAndAssertSlotFree, SlotTakenError } from "../engines/bookingWrite.js";
import { cancelAppointment } from "../engines/appointmentPromotion.js";
import { effectiveDurationForDate, effectivePriceForDate } from "../engines/pricing.js";
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
      "for the requested service and date range, in the shop's timezone. Slots YOU " +
      "are holding do NOT appear here (the hold hides them) - your active holds are " +
      "listed in the [context] note; book those by their held slot_id instead of " +
      "re-checking.",
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
      "Write the booking for a slot you hold. When the client accepts a time you " +
      "offered, call this DIRECTLY with the held slot_id from the [context] note - " +
      "do not re-run check_availability first. Availability is re-verified at write " +
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

const holdInput = z.object({ slot_id: z.string().min(1) });

const bookInput = z.object({
  slot_id: z.string().min(1),
  client_name: z.string().min(1).max(80).optional(),
});

const rescheduleInput = z.object({
  appointment_id: z.string().min(1),
  new_slot_id: z.string().min(1),
});

const cancelInput = z.object({ appointment_id: z.string().min(1) });

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

/**
 * The client's live holds, rendered for the per-turn context note. History
 * replays TEXT only (tool loops are intra-turn) and the slot engine hides a
 * held slot from check_availability - so without this note, an accept turn
 * ("yeah" / "the later one") has no way to recover the slot_id it holds, and
 * re-checking availability actively misleads the model into offering a
 * different time or barber. Returns null when the client holds nothing.
 */
export async function describeActiveHolds(params: {
  shopId: string;
  clientId: string;
  timezone: string;
  now: Date;
}): Promise<string | null> {
  const holds = await prisma.appointment.findMany({
    where: {
      shopId: params.shopId,
      clientId: params.clientId,
      status: "PENDING",
      bookedVia: "receptionist",
      holdExpiresAt: { gt: params.now },
    },
    orderBy: { startsAt: "asc" },
    take: 6,
    select: {
      staffId: true,
      serviceId: true,
      startsAt: true,
      holdExpiresAt: true,
      staff: { select: { name: true } },
      service: { select: { name: true } },
    },
  });
  if (holds.length === 0) return null;
  return holds
    .map((h) => {
      const minutes = Math.max(
        1,
        Math.round((h.holdExpiresAt!.getTime() - params.now.getTime()) / 60_000),
      );
      return (
        `- ${formatApptTime(h.startsAt, params.timezone)} with ${h.staff.name} ` +
        `(${h.service.name}) - slot_id ${encodeSlotId(h.staffId, h.serviceId, h.startsAt)} ` +
        `- hold expires in ${minutes} min`
      );
    })
    .join("\n");
}

/**
 * The client's upcoming BOOKED appointments for the same context note, with
 * their appointment_ids. "Can we move it to Saturday?" needs an
 * appointment_id for reschedule - and the model (correctly) no longer
 * re-pulls get_client_history every turn, so without this it books a SECOND
 * appointment instead of moving the first. Returns null when there are none.
 */
export async function describeUpcomingAppointments(params: {
  shopId: string;
  clientId: string;
  timezone: string;
  now: Date;
}): Promise<string | null> {
  const appts = await prisma.appointment.findMany({
    where: {
      shopId: params.shopId,
      clientId: params.clientId,
      status: "BOOKED",
      startsAt: { gt: params.now },
    },
    orderBy: { startsAt: "asc" },
    take: 5,
    select: {
      id: true,
      startsAt: true,
      staff: { select: { name: true } },
      service: { select: { name: true } },
    },
  });
  if (appts.length === 0) return null;
  return appts
    .map(
      (a) =>
        `- ${formatApptTime(a.startsAt, params.timezone)} with ${a.staff.name} ` +
        `(${a.service.name}) - appointment_id ${a.id}`,
    )
    .join("\n");
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

/** Everything a hold/book write needs about the decoded slot. */
async function loadSlotContext(
  ctx: ToolContext,
  slotId: string,
): Promise<
  | {
      staffId: string;
      serviceId: string;
      startsAt: Date;
      endsAt: Date;
      price: number | null;
      bufferMin: number;
      timezone: string;
      serviceName: string;
      staffName: string;
    }
  | string
> {
  const decoded = decodeSlotId(slotId);
  if (!decoded) return "invalid slot_id - use one returned by check_availability";
  if (decoded.startsAt.getTime() <= ctx.now.getTime()) {
    return "that slot is in the past";
  }
  const shop = await prisma.shop.findUnique({
    where: { id: ctx.shopId },
    select: { timezone: true, bookingBufferMin: true },
  });
  if (!shop) return "shop not found";
  const db = forShop(ctx.shopId);
  const [service, staff] = await Promise.all([
    db.service.findFirst({
      where: { id: decoded.serviceId, active: true },
      select: {
        id: true,
        name: true,
        durationMin: true,
        durationOverrides: true,
        price: true,
        priceOverrides: true,
      },
    }),
    db.staff.findFirst({
      where: { id: decoded.staffId, active: true },
      select: { id: true, name: true },
    }),
  ]);
  if (!service || !staff) return "that slot's barber or service is no longer offered";
  const price = effectivePriceForDate(
    service.price === null ? null : Number(service.price),
    service.priceOverrides,
    decoded.startsAt,
    shop.timezone,
  );
  return {
    staffId: decoded.staffId,
    serviceId: decoded.serviceId,
    startsAt: decoded.startsAt,
    // Effective duration for the slot's shop-local weekday (mirrors the price).
    endsAt: new Date(
      decoded.startsAt.getTime() +
        effectiveDurationForDate(
          service.durationMin,
          service.durationOverrides,
          decoded.startsAt,
          shop.timezone,
        ) *
          60_000,
    ),
    price,
    bufferMin: shop.bookingBufferMin,
    timezone: shop.timezone,
    serviceName: service.name,
    staffName: staff.name,
  };
}

/** The conversation's DB-resolved client - the ONLY identity a write may use. */
async function loadBookingIdentity(ctx: ToolContext): Promise<{
  clientId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
} | null> {
  if (!ctx.clientId) return null;
  const client = await forShop(ctx.shopId).client.findFirst({
    where: { id: ctx.clientId },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  if (!client) return null;
  return {
    clientId: client.id,
    firstName: client.firstName,
    lastName: client.lastName,
    email: client.email,
  };
}

const SLOT_LOST =
  "that slot just got taken - apologize once, run check_availability again and " +
  "offer the next-closest times";

async function holdSlot(ctx: ToolContext, rawInput: unknown): Promise<ToolExecutionResult> {
  const parsed = holdInput.safeParse(rawInput);
  if (!parsed.success) return fail("invalid input: slot_id required");
  const slot = await loadSlotContext(ctx, parsed.data.slot_id);
  if (typeof slot === "string") return fail(slot);
  const identity = await loadBookingIdentity(ctx);
  if (!identity) return fail("no client record for this number - escalate_to_human");

  // Hours/exceptions/bounds re-check (conflicts are the tx guard's job).
  const bookable = await isSlotBookable({
    shopId: ctx.shopId,
    staffId: slot.staffId,
    serviceId: slot.serviceId,
    startsAt: slot.startsAt,
    now: ctx.now,
  });
  if (!bookable) return fail("that time is outside the shop's bookable hours now");

  const expiresAt = new Date(ctx.now.getTime() + CONVERSATIONAL_HOLD_TTL_MS);
  try {
    const held = await prisma.$transaction(async (tx) => {
      await lockStaffAndAssertSlotFree(tx, {
        staffId: slot.staffId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        bufferMin: slot.bufferMin,
        now: ctx.now,
      });
      return tx.appointment.create({
        data: {
          shopId: ctx.shopId,
          staffId: slot.staffId,
          serviceId: slot.serviceId,
          clientId: identity.clientId,
          firstName: identity.firstName ?? "Client",
          lastName: identity.lastName,
          phone: ctx.phone,
          email: identity.email,
          status: "PENDING",
          holdExpiresAt: expiresAt,
          bookedVia: "receptionist",
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          priceAtBooking: slot.price ?? undefined,
          manageToken: randomToken(),
        },
        select: { id: true },
      });
    });
    return ok({
      held: true,
      slot_id: parsed.data.slot_id,
      when: formatApptTime(slot.startsAt, slot.timezone),
      expires_in_minutes: Math.round(CONVERSATIONAL_HOLD_TTL_MS / 60_000),
      hold_id: held.id,
    });
  } catch (err) {
    // P2002 = the (staffId, startsAt) partial-unique backstop fired under a
    // race the guard couldn't see. Same graceful degradation as book/
    // reschedule - a constraint violation must read as "slot lost", never as
    // an internal error that pushes the model to escalate.
    const uniqueRace =
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
    if (err instanceof SlotTakenError || uniqueRace) {
      // Idempotent re-hold: if the "conflict" is OUR OWN live hold on this
      // exact slot for this client, refresh its expiry instead of failing.
      const own = await prisma.appointment.findFirst({
        where: {
          shopId: ctx.shopId,
          staffId: slot.staffId,
          startsAt: slot.startsAt,
          clientId: identity.clientId,
          status: "PENDING",
          bookedVia: "receptionist",
          holdExpiresAt: { gt: ctx.now },
        },
        select: { id: true },
      });
      if (own) {
        await prisma.appointment.update({
          where: { id: own.id },
          data: { holdExpiresAt: expiresAt },
        });
        return ok({
          held: true,
          slot_id: parsed.data.slot_id,
          when: formatApptTime(slot.startsAt, slot.timezone),
          expires_in_minutes: Math.round(CONVERSATIONAL_HOLD_TTL_MS / 60_000),
          hold_id: own.id,
        });
      }
      return fail(SLOT_LOST);
    }
    throw err;
  }
}

async function bookAppointment(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolExecutionResult> {
  const parsed = bookInput.safeParse(rawInput);
  if (!parsed.success) return fail("invalid input: slot_id required");
  const slot = await loadSlotContext(ctx, parsed.data.slot_id);
  if (typeof slot === "string") return fail(slot);
  const identity = await loadBookingIdentity(ctx);
  if (!identity) return fail("no client record for this number - escalate_to_human");
  // Identity comes from the DB; the model may only FILL a missing first name.
  const firstName = identity.firstName ?? parsed.data.client_name ?? "Client";
  // An SMS walk-in gave their name for the first time: persist it to the
  // Client row (not just the appointment) so get_client_history and the
  // dashboard recognize them next time. Only when the row had no name AND the
  // model supplied one - never overwrite an existing name from model text.
  const nameToBackfill =
    identity.firstName === null && parsed.data.client_name
      ? parsed.data.client_name.slice(0, 80)
      : null;

  try {
    const bookedId = await prisma.$transaction(async (tx) => {
      // Our own live-or-expired hold on this exact slot, if any.
      const hold = await tx.appointment.findFirst({
        where: {
          shopId: ctx.shopId,
          staffId: slot.staffId,
          startsAt: slot.startsAt,
          clientId: identity.clientId,
          status: "PENDING",
          bookedVia: "receptionist",
          holdExpiresAt: { not: null },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, holdExpiresAt: true },
      });

      // The client is committing to ONE slot - release their OTHER live holds
      // (the alternates offered alongside it) so those slots free instantly
      // and later context turns don't show stale holds that confuse the model
      // into re-offering. Before the guard, so a buffer-adjacent own hold
      // can't false-positive it. Light flip, never notifySlotOpened; rolls
      // back with the tx if the booking fails.
      await tx.appointment.updateMany({
        where: {
          shopId: ctx.shopId,
          clientId: identity.clientId,
          status: "PENDING",
          bookedVia: "receptionist",
          holdExpiresAt: { not: null },
          ...(hold ? { id: { not: hold.id } } : {}),
        },
        data: { status: "CANCELED", canceledAt: ctx.now },
      });

      if (hold) {
        // ACTIVE hold: BOOKED-only re-check (approve-path parity - our own row
        // is the PENDING one, and any conflicting PENDING would have failed its
        // create guard while our hold was live). EXPIRED hold: the slot was
        // released, so a new PENDING may exist - count BOOKED+PENDING again.
        const active =
          hold.holdExpiresAt !== null && hold.holdExpiresAt.getTime() > ctx.now.getTime();
        await lockStaffAndAssertSlotFree(tx, {
          staffId: slot.staffId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          bufferMin: slot.bufferMin,
          excludeAppointmentId: hold.id,
          statuses: active ? ["BOOKED"] : ["BOOKED", "PENDING"],
          now: ctx.now,
        });
        await tx.appointment.update({
          where: { id: hold.id },
          data: {
            status: "BOOKED",
            holdExpiresAt: null, // no longer a hold - a real booking
            firstName,
            // The agent's SMS IS the confirmation - stamp so no other path
            // double-sends. The ~24h reminder flow stays untouched.
            confirmationSentAt: ctx.now,
          },
        });
        return hold.id;
      }

      // No hold (the model skipped hold_slot): book directly under the guard.
      await lockStaffAndAssertSlotFree(tx, {
        staffId: slot.staffId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        bufferMin: slot.bufferMin,
        now: ctx.now,
      });
      const appt = await tx.appointment.create({
        data: {
          shopId: ctx.shopId,
          staffId: slot.staffId,
          serviceId: slot.serviceId,
          clientId: identity.clientId,
          firstName,
          lastName: identity.lastName,
          phone: ctx.phone,
          email: identity.email,
          status: "BOOKED",
          bookedVia: "receptionist",
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          priceAtBooking: slot.price ?? undefined,
          manageToken: randomToken(),
          confirmationSentAt: ctx.now,
        },
        select: { id: true },
      });
      return appt.id;
    });

    // Backfill the walk-in's name onto the Client row (outside the booking tx;
    // a failure here must not undo a successful booking). Guarded on still-null
    // so two racing books don't clobber.
    if (nameToBackfill) {
      await prisma.client
        .updateMany({
          where: { id: identity.clientId, firstName: null },
          data: { firstName: nameToBackfill },
        })
        .catch(() => {});
    }

    return ok({
      booked: true,
      appointment_id: bookedId,
      when: formatApptTime(slot.startsAt, slot.timezone),
      service: slot.serviceName,
      barber: slot.staffName,
      price: slot.price,
      note: "confirm the exact date+time+service back to the client in your reply",
    });
  } catch (err) {
    if (err instanceof SlotTakenError) return fail(SLOT_LOST);
    // P2002 = the partial-unique backstop fired on an identical-start race.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return fail(SLOT_LOST);
    }
    throw err;
  }
}

/**
 * The client's own upcoming appointment, or an error string. Ownership is by
 * the conversation's DB-resolved clientId - a texter can never touch someone
 * else's booking no matter what id the model passes.
 */
async function loadOwnAppointment(ctx: ToolContext, appointmentId: string) {
  if (!ctx.clientId) return "no client record for this number" as const;
  const appt = await runWithShop(ctx.shopId, (tx) =>
    tx.appointment.findFirst({
      where: {
        id: appointmentId,
        shopId: ctx.shopId,
        clientId: ctx.clientId!,
        holdExpiresAt: null, // holds aren't appointments
      },
      select: {
        id: true,
        status: true,
        staffId: true,
        serviceId: true,
        startsAt: true,
        endsAt: true,
        payment: { select: { status: true, amount: true } },
      },
    }),
  );
  if (!appt) {
    return "no such appointment for this client - use get_client_history to list theirs" as const;
  }
  return appt;
}

async function rescheduleTool(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolExecutionResult> {
  const parsed = rescheduleInput.safeParse(rawInput);
  if (!parsed.success) return fail("invalid input: appointment_id and new_slot_id required");

  const appt = await loadOwnAppointment(ctx, parsed.data.appointment_id);
  if (typeof appt === "string") return fail(appt);
  if (appt.status !== "BOOKED" || appt.startsAt.getTime() <= ctx.now.getTime()) {
    return fail("that appointment can't be moved (not an upcoming booked appointment)");
  }

  const slot = await loadSlotContext(ctx, parsed.data.new_slot_id);
  if (typeof slot === "string") return fail(slot);
  if (slot.serviceId !== appt.serviceId) {
    return fail(
      "a reschedule keeps the same service - to change services, cancel and book fresh",
    );
  }

  // Paid booking + different price on the new date: self-serve can't reconcile
  // the captured charge (same rule as the public manage page) - hand off.
  const paidCents =
    appt.payment && appt.payment.status === "succeeded" ? appt.payment.amount : null;
  if (paidCents !== null) {
    const newCents = slot.price === null ? null : Math.round(slot.price * 100);
    if (newCents !== null && newCents !== paidCents) {
      return fail(
        "this booking is already paid and the new date has a different price - " +
          "escalate_to_human so the barber can move it",
      );
    }
  }

  const bookable = await isSlotBookable({
    shopId: ctx.shopId,
    staffId: slot.staffId,
    serviceId: slot.serviceId,
    startsAt: slot.startsAt,
    now: ctx.now,
    excludeAppointmentId: appt.id,
  });
  if (!bookable) return fail("that new time is outside the shop's bookable hours");

  try {
    await prisma.$transaction(async (tx) => {
      // Consume the client's live holds first. The normal flow holds the
      // target before asking ("want Sat 10 instead?"), and that own hold
      // would otherwise block its own reschedule as an active PENDING
      // overlap. Alternates are moot once the move commits; the flip rolls
      // back with the tx if it doesn't. Never notifySlotOpened.
      await tx.appointment.updateMany({
        where: {
          shopId: ctx.shopId,
          clientId: ctx.clientId!,
          status: "PENDING",
          bookedVia: "receptionist",
          holdExpiresAt: { not: null },
        },
        data: { status: "CANCELED", canceledAt: ctx.now },
      });
      await lockStaffAndAssertSlotFree(tx, {
        staffId: slot.staffId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        bufferMin: slot.bufferMin,
        excludeAppointmentId: appt.id,
        now: ctx.now,
      });
      await tx.appointment.update({
        where: { id: appt.id },
        data: {
          staffId: slot.staffId, // the new slot may be with a different barber
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          priceAtBooking: slot.price ?? null,
          // The agent's SMS is the fresh confirmation; the ~24h reminder
          // re-arms for the new time - including the PUSH reminder stamps.
          // Check-in state from the old time is cleared too.
          confirmationSentAt: ctx.now,
          reminderSentAt: null,
          reminder24hPushSentAt: null,
          reminder2hPushSentAt: null,
          checkInStatus: null,
          checkedInAt: null,
          etaMinutes: null,
          runningLate: false,
        },
      });
    });
  } catch (err) {
    if (err instanceof SlotTakenError) return fail(SLOT_LOST);
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return fail(SLOT_LOST);
    }
    throw err;
  }

  return ok({
    rescheduled: true,
    appointment_id: appt.id,
    new_time: formatApptTime(slot.startsAt, slot.timezone),
    barber: slot.staffName,
    service: slot.serviceName,
    note: "confirm the new date+time back to the client",
  });
}

async function cancelTool(ctx: ToolContext, rawInput: unknown): Promise<ToolExecutionResult> {
  const parsed = cancelInput.safeParse(rawInput);
  if (!parsed.success) return fail("invalid input: appointment_id required");

  const appt = await loadOwnAppointment(ctx, parsed.data.appointment_id);
  if (typeof appt === "string") return fail(appt);
  if (appt.status !== "BOOKED" || appt.startsAt.getTime() <= ctx.now.getTime()) {
    return fail("that appointment can't be cancelled (not an upcoming booked appointment)");
  }

  // Customer-initiated: the shop's cancellation policy applies (a fee may be
  // kept inside the window), and the freed slot fires the slot-opened flow -
  // which is exactly what feeds the gap-filler.
  const okCancel = await cancelAppointment(ctx.shopId, appt.id, "CANCELED", ctx.now, {
    applyPolicyFee: true,
  });
  if (!okCancel) return fail("cancel failed - escalate_to_human");

  const shop = await prisma.shop.findUnique({
    where: { id: ctx.shopId },
    select: { timezone: true },
  });
  return ok({
    cancelled: true,
    appointment_id: appt.id,
    was: formatApptTime(appt.startsAt, shop?.timezone ?? "America/New_York"),
    note: "keep it warm - no guilt-trip, leave the door open",
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
        case "hold_slot":
          return await holdSlot(ctx, input);
        case "book_appointment":
          return await bookAppointment(ctx, input);
        case "reschedule":
          return await rescheduleTool(ctx, input);
        case "cancel":
          return await cancelTool(ctx, input);
        default:
          return fail(`unknown tool: ${name}`);
      }
    } catch (err) {
      logger.error({ err, tool: name, shopId: ctx.shopId }, "receptionist tool failed");
      return fail("internal error running this tool - consider escalate_to_human");
    }
  };
}
