import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { zonedWallTimeToUtc } from "@chairback/config";
import { prisma, runWithShop } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireRole } from "../auth/roles.js";
import { requireActiveAccess } from "../middleware/billing.js";
import { teamScheduleHook } from "../middleware/teamScheduleHook.js";
import { noteAvailabilityChanged } from "../services/availabilityCache.js";
import { computeOpenSlots } from "../engines/slots.js";
import { effectiveDurationAt } from "../engines/pricing.js";
import { carriedExtraMin } from "../engines/moveLength.js";
import { TARGETED_SLOT_ORIGIN } from "../engines/specialBooking.js";
import { createBlocks, planBlock, removeBlocks } from "../services/blockOff.js";
import { dayKeyIn, readChairDay } from "../services/chairDay.js";
import {
  availabilitySchema,
  readStaffAvailability,
  replaceStaffAvailability,
} from "../services/staffAvailability.js";
import { runWriteCore, type WriteAnswer } from "../services/dashboardWriteCore.js";
import {
  BOTH_OR_NEITHER,
  blockConfirmation,
  blockReason,
  blockRequestId,
  bothOrNeither,
  sendCreated,
  toWhen,
  whenSchema,
} from "./booking.blocks.js";
import {
  cancelAppointmentCore,
  createAppointmentCore,
  rescheduleAppointmentCore,
} from "./booking.dashboard.js";

/**
 * A team member's OWN calendar: any day, their own hours, their own time off,
 * and booking, moving or cancelling their own clients.
 *
 * WHY THIS IS ITS OWN ROUTER. Everything here already exists for an owner or
 * manager on /api/booking, behind `requireManager`. That gate is never
 * loosened: a route added to the dashboard later must stay closed to a team
 * member by default (see auth/roles.ts and routes/barber.ts). So a team member
 * gets a short allow-list of their own, and each route below calls the same
 * shared code the dashboard calls - the hours read and write
 * (services/staffAvailability.ts), the block service (services/blockOff.ts)
 * and the dashboard's own book / move / cancel handlers
 * (services/dashboardWriteCore.ts). No booking rule is restated here.
 *
 * 🔴 THE ONE RULE: WHOSE calendar this is comes from the session, through
 * `ownStaffId(req)`, and from nowhere else. No route reads a staff id from the
 * URL, the query or the body, and the strict schemas below refuse a body that
 * tries to carry one. An appointment or a block named by id is looked up WITH
 * that staff id in the where-clause, so somebody else's answers 404 - the same
 * answer as "does not exist", which also keeps the route from being used to
 * probe the rest of the shop's book.
 *
 * What a team member never gets here: what the shop took, how a visit was
 * paid, a tip, a refund, another person's bookings or clients, a price they
 * set themselves, a time forced outside their hours, or a booking over
 * somebody else's blocked time. The write handlers' answers are reduced to an
 * allow-list (`answerWrite`) for the same reason.
 */
export const barberCalendarRouter: Router = Router();

// Owners and managers pass the role gate too, like routes/barber.ts: the view
// is usable from a real account, and an owner who works a spot gets the same
// calendar. The scoping still applies to whichever spot their seat is on.
barberCalendarRouter.use(
  requireUser,
  requireShop,
  requireRole("OWNER", "MANAGER", "BARBER"),
  requireActiveAccess,
);

// Any successful write here changes what the public booking page offers (the
// hours, time off, a booking taken or freed). Same hook as the dashboard
// router: after the response, and only when the write went through.
barberCalendarRouter.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  const shopId = req.shop?.id;
  if (shopId) {
    res.on("finish", () => {
      if (res.statusCode < 400) void noteAvailabilityChanged(shopId);
    });
  }
  next();
});

/** Everything below is about one person's calendar, so everything needs one. */
function requireOwnStaff(req: Request, res: Response, next: NextFunction): void {
  if (!req.shopStaffId) {
    res.status(403).json({ error: "no_chair" });
    return;
  }
  next();
}
barberCalendarRouter.use(requireOwnStaff);

/** 🔴 The only place a staff id comes from in this file. */
function ownStaffId(req: Request): string {
  return req.shopStaffId!;
}

const DAY_KEY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

/** One shop-local day as two instants, or null when the date is not a real day. */
function dayBounds(day: string, timezone: string): { from: Date; to: Date } | null {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return {
    from: zonedWallTimeToUtc(y, m - 1, d, 0, timezone),
    to: zonedWallTimeToUtc(y, m - 1, d + 1, 0, timezone),
  };
}

/** How far from today the day view will go, either way. */
const MAX_DAYS_AWAY = 400;

// ── the day ───────────────────────────────────────────────────────────────

const dayQuerySchema = z.object({ date: DAY_KEY.optional() }).strict();

/**
 * GET /day?date=YYYY-MM-DD - this person's bookings and time off for one
 * shop-local day (today when no date is given).
 */
barberCalendarRouter.get("/day", async (req, res) => {
  const parsed = dayQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const shopId = req.shop!.id;
  const staffId = ownStaffId(req);
  // Shop has RLS with no policy: read as the owner, outside forShop.
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { name: true, timezone: true, bookingMode: true },
  });
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const now = new Date();
  const today = dayKeyIn(shop.timezone, now);
  const day = parsed.data.date ?? today;
  const bounds = dayBounds(day, shop.timezone);
  if (!bounds || Math.abs(bounds.from.getTime() - now.getTime()) > MAX_DAYS_AWAY * 86_400_000) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }

  const [rows, extra] = await Promise.all([
    readChairDay({
      shopId,
      staffId,
      timezone: shop.timezone,
      from: bounds.from,
      to: bounds.to,
      day,
    }),
    runWithShop(shopId, async (tx) => {
      const [staff, blocks] = await Promise.all([
        tx.staff.findFirst({ where: { id: staffId, shopId }, select: { id: true, name: true } }),
        tx.availabilityException.findMany({
          where: {
            shopId,
            staffId,
            isBlock: true,
            startsAt: { lt: bounds.to },
            endsAt: { gt: bounds.from },
          },
          orderBy: { startsAt: "asc" },
          take: 50,
          select: { id: true, startsAt: true, endsAt: true, reason: true, groupId: true },
        }),
      ]);
      const shared = await sharedGroups(tx, shopId, staffId, blocks.map((b) => b.groupId));
      return { staff, blocks, shared };
    }),
  ]);

  res.json({
    chair: extra.staff ? { id: extra.staff.id, name: extra.staff.name } : null,
    shop: { name: shop.name, timezone: shop.timezone },
    date: day,
    today,
    // Booking from here runs ChairBack's own calendar; a shop still on a
    // synced calendar books there.
    canBook: shop.bookingMode === "native",
    rows: rows.map((r) => ({
      ...r,
      // Only a booking still to come can be moved or cancelled from here.
      canChange: r.status === "BOOKED" && new Date(r.startsAt).getTime() > now.getTime(),
    })),
    blocks: extra.blocks.map((b) => ({
      id: b.id,
      startsAt: b.startsAt.toISOString(),
      endsAt: b.endsAt.toISOString(),
      reason: b.reason,
      // Set for the whole shop (or several people) in one save: theirs to see,
      // not theirs to remove.
      shared: b.groupId !== null && extra.shared.has(b.groupId),
    })),
  });
});

/**
 * Which of these block groups also cover somebody else. One "Block off time"
 * save can cover several people (a shop closure); those rows share a groupId.
 */
async function sharedGroups(
  tx: Parameters<Parameters<typeof runWithShop>[1]>[0],
  shopId: string,
  staffId: string,
  groupIds: (string | null)[],
): Promise<Set<string>> {
  const ids = [...new Set(groupIds.filter((g): g is string => g !== null))];
  if (ids.length === 0) return new Set();
  const others = await tx.availabilityException.findMany({
    where: { shopId, groupId: { in: ids }, staffId: { not: staffId } },
    distinct: ["groupId"],
    select: { groupId: true },
  });
  return new Set(others.map((o) => o.groupId).filter((g): g is string => g !== null));
}

// ── own hours ─────────────────────────────────────────────────────────────

/** GET /hours - this person's weekly hours, standing breaks and time off to come. */
barberCalendarRouter.get("/hours", async (req, res) => {
  const shopId = req.shop!.id;
  const staffId = ownStaffId(req);
  const week = await readStaffAvailability(shopId, staffId);
  if (!week) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const groups = await runWithShop(shopId, async (tx) => {
    const rows = await tx.availabilityException.findMany({
      where: { shopId, staffId, id: { in: week.exceptions.map((e) => e.id) } },
      select: { id: true, groupId: true },
    });
    const shared = await sharedGroups(tx, shopId, staffId, rows.map((r) => r.groupId));
    return new Map(rows.map((r) => [r.id, r.groupId !== null && shared.has(r.groupId)]));
  });
  res.json({
    ...week,
    exceptions: week.exceptions.map((e) => ({ ...e, shared: groups.get(e.id) ?? false })),
    timezone: req.shop!.timezone,
  });
});

/** PUT /hours - replace this person's whole week. Same body as the dashboard's editor. */
barberCalendarRouter.put("/hours", teamScheduleHook, async (req, res) => {
  const parsed = availabilitySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const ok = await replaceStaffAvailability(req.shop!.id, ownStaffId(req), parsed.data);
  if (!ok) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});

// ── own time off ──────────────────────────────────────────────────────────

/**
 * The dashboard's block form, minus the two things that are not a team
 * member's to choose: WHO (always themselves) and WHICH SERVICES (all of
 * them). `.strict()` is what refuses a `staffIds` that tries to ride along.
 */
const timeOffSchema = z
  .object({
    when: whenSchema.refine((w) => w.kind === "continuous" || bothOrNeither(w), BOTH_OR_NEITHER),
    reason: blockReason,
    requestId: blockRequestId,
    confirmation: blockConfirmation,
  })
  .strict();

/**
 * POST /time-off - block time on their own calendar. The same save as the
 * dashboard's (services/blockOff.ts): bookings in the way are named and must
 * be confirmed, and no booking is ever cancelled or moved by it.
 */
barberCalendarRouter.post("/time-off", teamScheduleHook, async (req, res) => {
  const parsed = timeOffSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const timezone = req.shop!.timezone;
  const now = new Date();
  const plan = planBlock(toWhen(d.when), timezone, now);
  if (!plan.ok) {
    res.status(400).json({
      error: "invalid_input",
      issues: [{ path: ["when", plan.field], message: plan.message }],
    });
    return;
  }
  const outcome = await createBlocks({
    shopId: req.shop!.id,
    timezone,
    staffIds: [ownStaffId(req)],
    spans: plan.spans,
    pattern: plan.pattern,
    isBlock: true,
    reason: d.reason || null,
    requestId: d.requestId ?? null,
    confirmation: d.confirmation ?? null,
    now,
    serviceIds: [],
  });
  sendCreated(res, req, outcome, false);
});

/**
 * DELETE /time-off/:id - remove ONE block of their own. Never a whole group
 * (a group can reach other people), and never a block that was set for
 * several people at once: that is the shop's, and only the dashboard removes
 * it.
 */
barberCalendarRouter.delete("/time-off/:id", teamScheduleHook, async (req, res) => {
  const shopId = req.shop!.id;
  const staffId = ownStaffId(req);
  const id = req.params.id!;
  const found = await runWithShop(shopId, async (tx) => {
    const block = await tx.availabilityException.findFirst({
      where: { id, shopId, staffId, isBlock: true },
      select: { id: true, groupId: true },
    });
    if (!block) return null;
    const shared = await sharedGroups(tx, shopId, staffId, [block.groupId]);
    return { shared: block.groupId !== null && shared.has(block.groupId) };
  });
  if (!found) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (found.shared) {
    res.status(403).json({ error: "shop_block" });
    return;
  }
  const { removed } = await removeBlocks({ shopId, id, scope: "one", now: new Date() });
  if (removed === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});

// ── booking: what they offer, and when they are free ──────────────────────

/** GET /services - the active services this person offers, in menu order. */
barberCalendarRouter.get("/services", async (req, res) => {
  const shopId = req.shop!.id;
  const staffId = ownStaffId(req);
  const services = await runWithShop(shopId, (tx) =>
    tx.service.findMany({
      where: { shopId, active: true, staff: { some: { staffId } } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      take: 200,
      select: { id: true, name: true, durationMin: true, price: true },
    }),
  );
  res.json({
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      durationMin: s.durationMin,
      price: s.price === null ? null : Number(s.price),
    })),
  });
});

const slotsQuerySchema = z
  .object({
    date: DAY_KEY,
    /** A new booking: the service being booked. */
    serviceId: z.string().min(1).max(64).optional(),
    /** A move: the booking being moved (its own service and length are used). */
    appointmentId: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine((q) => Boolean(q.serviceId) !== Boolean(q.appointmentId), {
    message: "Send a service to book, or an appointment to move.",
  });

/**
 * GET /slots - open times on their own calendar for one day: for a new
 * booking of a service, or for moving one of their bookings.
 *
 * 🔴 THE LIST MUST MATCH THE WRITE. The same engine the book and move handlers
 * check a picked time with, asked the same question: a move carries the
 * booking's own extra minutes (its add-ons) and ignores the booking's current
 * place, exactly as the reschedule handler does.
 */
barberCalendarRouter.get("/slots", async (req, res) => {
  const parsed = slotsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const shopId = req.shop!.id;
  const staffId = ownStaffId(req);
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { bookingMode: true, timezone: true },
  });
  if (!shop || shop.bookingMode !== "native") {
    res.status(400).json({ error: "not_native" });
    return;
  }
  const bounds = dayBounds(parsed.data.date, shop.timezone);
  if (!bounds) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const now = new Date();
  // From now, if the day has already begun - as the booking page asks.
  const fromDate = bounds.from.getTime() > now.getTime() ? bounds.from : now;

  let serviceId: string;
  let excludeAppointmentId: string | undefined;
  let extraDurationMin = 0;
  if (parsed.data.appointmentId) {
    const appt = await runWithShop(shopId, (tx) =>
      tx.appointment.findFirst({
        where: { id: parsed.data.appointmentId!, shopId, staffId },
        select: {
          id: true,
          status: true,
          startsAt: true,
          endsAt: true,
          serviceId: true,
          bookedVia: true,
          service: { select: { durationMin: true, durationOverrides: true, timeOverrides: true } },
        },
      }),
    );
    if (!appt) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (appt.status !== "BOOKED" || appt.startsAt <= now) {
      res.json({ timezone: shop.timezone, slots: [] });
      return;
    }
    serviceId = appt.serviceId;
    excludeAppointmentId = appt.id;
    // A special being left takes the menu's length (no extra) - the same rule
    // the client's own move list uses (routes/booking.public.ts).
    extraDurationMin =
      appt.bookedVia === TARGETED_SLOT_ORIGIN
        ? 0
        : carriedExtraMin({
            currentMin: Math.round((appt.endsAt.getTime() - appt.startsAt.getTime()) / 60_000),
            serviceMinAtOld: effectiveDurationAt(appt.service.durationMin, {
              at: appt.startsAt,
              timezone: shop.timezone,
              weekdayOverrides: appt.service.durationOverrides,
              timeWindows: appt.service.timeOverrides,
            }),
          });
  } else {
    // A service this person does not offer is not theirs to list times for.
    const offered = await runWithShop(shopId, (tx) =>
      tx.service.findFirst({
        where: { id: parsed.data.serviceId!, shopId, active: true, staff: { some: { staffId } } },
        select: { id: true },
      }),
    );
    if (!offered) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    serviceId = offered.id;
  }

  const slots = await computeOpenSlots({
    shopId,
    staffId,
    serviceId,
    fromDate,
    toDate: bounds.to,
    now,
    excludeAppointmentId,
    extraDurationMin,
  });
  res.json({
    timezone: shop.timezone,
    slots: slots.map((s) => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() })),
  });
});

// ── booking: the three writes ─────────────────────────────────────────────

/**
 * What a write answers a team member with. The dashboard's handlers answer
 * with more than a team member should read (the mirror to a synced calendar,
 * an offer's sums, the bookings a refusal names), so the answer is rebuilt
 * from an allow-list rather than passed through.
 */
function answerWrite(res: Response, r: WriteAnswer, okBody: Record<string, unknown>): void {
  if (r.status === 200 || r.status === 201) {
    res.status(r.status).json({ ok: true, ...okBody });
    return;
  }
  const error = typeof r.body.error === "string" ? r.body.error : "failed";
  // A different price at the new time: their own booking's two figures, which
  // they must see before the move is made.
  if (error === "price_changes") {
    res.status(409).json({
      error,
      fromCents: Number(r.body.fromCents),
      toCents: Number(r.body.toCents),
    });
    return;
  }
  // 5xx stays 5xx; every refusal keeps its status and its code, nothing else.
  res.status(r.status >= 400 ? r.status : 409).json({ error });
}

/** Statuses that make someone this person's client - the same rule as their client list. */
const OWNING_STATUSES = ["BOOKED", "COMPLETED"] as const;

const bookSchema = z
  .object({
    serviceId: z.string().min(1).max(64),
    startsAt: z.coerce.date(),
    /** One of their own clients... */
    clientId: z.string().min(1).max(64).optional(),
    /** ...or somebody new, by name. */
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().max(80).optional(),
    phone: z.string().trim().max(40).optional(),
    email: z.string().trim().email().max(200).optional().or(z.literal("")),
    note: z.string().trim().max(1000).optional(),
    /** Minted by the form once per submission, re-sent on a retry: one booking. */
    operationId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  })
  .strict()
  .refine((d) => Boolean(d.clientId) !== Boolean(d.firstName), {
    message: "Pick one of your clients, or enter a name.",
    path: ["clientId"],
  });

/**
 * POST /appointments - book a client on their own calendar, at an open time.
 *
 * The body is rebuilt field by field: the staff id is the session's, and the
 * dashboard's options a team member does not get (a forced time, their own
 * price, booking over a blocked time or over another booking, an offer code,
 * a repeat, a special) are simply never sent to the handler.
 */
barberCalendarRouter.post("/appointments", async (req, res) => {
  const parsed = bookSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const shopId = req.shop!.id;
  const staffId = ownStaffId(req);

  if (d.clientId) {
    // 🔴 Only somebody who has sat with THIS person. Without this, a client id
    // from anywhere in the shop's book would be accepted, and the booking's
    // confirmation would tell the team member whose it was.
    const theirs = await runWithShop(shopId, (tx) =>
      tx.appointment.findFirst({
        where: {
          shopId,
          staffId,
          clientId: d.clientId!,
          status: { in: [...OWNING_STATUSES] },
          holdExpiresAt: null,
        },
        select: { id: true },
      }),
    );
    if (!theirs) {
      res.status(404).json({ error: "client_not_found" });
      return;
    }
  }

  const r = await runWriteCore(
    createAppointmentCore,
    { shop: req.shop, userId: req.userId!, shopStaffId: staffId },
    {
      staffId,
      serviceId: d.serviceId,
      startsAt: d.startsAt.toISOString(),
      ...(d.clientId
        ? { clientId: d.clientId }
        : {
            firstName: d.firstName,
            ...(d.lastName ? { lastName: d.lastName } : {}),
            ...(d.phone ? { phone: d.phone } : {}),
            ...(d.email ? { email: d.email } : {}),
          }),
      ...(d.note ? { note: d.note } : {}),
      // Its own namespace: a team member's id can never answer for (or be
      // answered by) a booking made from the dashboard.
      operationId: `own-cal:${d.operationId}`,
    },
  );
  answerWrite(res, r, { id: typeof r.body.id === "string" ? r.body.id : null });
});

/** One of their own bookings by id, or null - the check every write below starts with. */
async function ownAppointment(shopId: string, staffId: string, id: string) {
  return runWithShop(shopId, (tx) =>
    tx.appointment.findFirst({
      where: { id, shopId, staffId },
      select: { id: true, status: true, startsAt: true },
    }),
  );
}

const moveSchema = z
  .object({
    startsAt: z.coerce.date(),
    /** The new time's price, in cents, as a 409 `price_changes` showed it. */
    acceptPriceCents: z.number().int().min(0).optional(),
  })
  .strict();

/** POST /appointments/:id/move - move one of their own bookings to an open time. */
barberCalendarRouter.post("/appointments/:id/move", async (req, res) => {
  const parsed = moveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const staffId = ownStaffId(req);
  const appt = await ownAppointment(req.shop!.id, staffId, req.params.id!);
  if (!appt) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const r = await runWriteCore(
    rescheduleAppointmentCore,
    { shop: req.shop, userId: req.userId!, shopStaffId: staffId },
    {
      startsAt: parsed.data.startsAt.toISOString(),
      ...(parsed.data.acceptPriceCents !== undefined
        ? { acceptPriceCents: parsed.data.acceptPriceCents }
        : {}),
    },
    { id: appt.id },
  );
  answerWrite(res, r, {});
});

const cancelSchema = z.object({}).strict();

/**
 * POST /appointments/:id/cancel - cancel one of their own bookings that is
 * still to come. The shop's usual rules run (what is refunded, the email the
 * client gets); recording it as the client's late cancel, with a fee, stays
 * with the owner.
 */
barberCalendarRouter.post("/appointments/:id/cancel", async (req, res) => {
  const parsed = cancelSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const staffId = ownStaffId(req);
  const appt = await ownAppointment(req.shop!.id, staffId, req.params.id!);
  if (!appt) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // The dashboard's handler can also cancel a finished visit (which claws back
  // loyalty and revenue). That is the owner's call, not this route's.
  if (appt.status !== "BOOKED" || appt.startsAt <= new Date()) {
    res.status(409).json({ error: "not_cancellable" });
    return;
  }
  const r = await runWriteCore(
    cancelAppointmentCore,
    { shop: req.shop, userId: req.userId!, shopStaffId: staffId },
    {},
    { id: appt.id },
  );
  if (r.status === 200 && r.body.ok !== true) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  answerWrite(res, r, {});
});
