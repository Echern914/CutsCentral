import { Router } from "express";
import { z } from "zod";
import { randomToken, SERVICE_COLOR_KEYS } from "@chairback/config";
import { forShop, prisma, Prisma, runWithShop } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import {
  cancelAppointment,
  cancelSeries,
  promoteOneAppointmentInTx,
  type CancelSeriesScope,
} from "../engines/appointmentPromotion.js";
import { recomputeCadence } from "../engines/cadence.js";
import { notifyPunchEarned } from "../services/loyaltyNotify.js";
import { notifyAppointmentConfirmation } from "../services/appointmentNotify.js";
import { deriveAcuityClientKey, toE164 } from "../acuity/clientKey.js";
import { computeOpenSlots, isSlotBookable } from "../engines/slots.js";
import { lockStaffAndAssertSlotFree } from "../engines/bookingWrite.js";
import {
  APPOINTMENT_NUDGE_KIND,
  APPOINTMENT_NUDGE_LIMIT,
  NudgeLimitError,
  sendAppointmentNudge,
} from "../engines/appointmentNudge.js";
import { resolveAddOns } from "../engines/addOns.js";
import { effectiveDurationForDate, effectivePriceForDate } from "../engines/pricing.js";
import {
  materializeSeries,
  type RecurrencePattern,
} from "../engines/recurringSeries.js";
import { zonedDateParts, zonedWallTimeToUtc, localMinutesOfDay } from "@chairback/config";
import { logger } from "../logger.js";

/**
 * Authenticated dashboard config for the native booking engine: the barber's
 * CRUD over staff, services, weekly availability, and the upcoming appointment
 * list (cancel / no-show / mark-done). Every read/write is tenant-scoped through
 * forShop (RLS-enforced); multi-statement mutations use runWithShop directly.
 *
 * The public customer-facing booking lives in booking.public.ts.
 */
export const bookingDashboardRouter: Router = Router();
bookingDashboardRouter.use(requireUser, requireShop);

//  Services

// Per-weekday price overrides: keys are weekdays "0".."6" (0=Sun), values are
// the price for that day. Only days that differ from the base price need an
// entry. Validated to keep the JSON column clean (known keys, non-negative).
const priceOverridesSchema = z
  .record(z.enum(["0", "1", "2", "3", "4", "5", "6"]), z.number().min(0).max(100000))
  .optional();

// Per-weekday DURATION overrides, same key shape ({weekday: minutes}). Bounds
// mirror durationMin's 5..600.
const durationOverridesSchema = z
  .record(z.enum(["0", "1", "2", "3", "4", "5", "6"]), z.number().int().min(5).max(600))
  .optional();

// Per-weekday AVAILABLE-HOURS restriction: {weekday: [{s,e}]} where s/e are
// minutes from shop-local midnight (e exclusive), e.g. {"1":[{"s":600,"e":840}]}
// = "Mondays only 10:00-14:00". A weekday absent from the map is unrestricted; a
// present weekday with [] means the service isn't offered that day. Capped at a
// handful of windows/day. The engine intersects these with staff availability.
const serviceWindowSchema = z
  .object({
    // s is a START minute so it can never be 1440 (end-of-day midnight); e is
    // exclusive so it can be 1440. These bounds must stay in lockstep with the
    // engine parser (parseServiceHours) so the write-time check and the read-time
    // defense never diverge on what a valid window is.
    s: z.number().int().min(0).max(1439),
    e: z.number().int().min(1).max(1440),
  })
  .refine((w) => w.e > w.s, { message: "window end must be after start" });
const hoursWindowsSchema = z
  .record(z.enum(["0", "1", "2", "3", "4", "5", "6"]), z.array(serviceWindowSchema).max(6))
  .optional();

const serviceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    // Roomy enough for a multi-line "INCLUDES:" bullet list on the public
    // booking card (the whole point of the richer menu). Newlines are preserved
    // in the column; the card renders them with whitespace-pre-line.
    description: z.string().trim().max(800).optional().or(z.literal("")),
    // Per-service booking-card photo. Same http(s) boundary as staff.imageUrl.
    imageUrl: z
      .string()
      .trim()
      .url()
      .max(500)
      .refine((u) => /^https?:\/\//i.test(u), "Must be an http(s) URL")
      .optional()
      .or(z.literal("")),
    durationMin: z.number().int().min(5).max(600),
    durationOverrides: durationOverridesSchema,
    hoursWindows: hoursWindowsSchema,
    price: z.number().min(0).max(100000).nullable().optional(),
    priceOverrides: priceOverridesSchema,
    // Calendar color: one of the palette keys, or null to clear. Validated
    // against the known keys so a bad value can't land in the column.
    color: z
      .enum(SERVICE_COLOR_KEYS as [string, ...string[]])
      .nullable()
      .optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    // "Offered by every barber" as a live intent. When true, staffIds is ignored
    // and the offering is kept in sync with all active staff (now and future).
    offeredByAll: z.boolean().optional(),
    // Which staff offer this service (ids). Replaces the offering set on write.
    // Ignored when offeredByAll is true.
    staffIds: z.array(z.string().min(1)).max(100).optional(),
  })
  .strict();

bookingDashboardRouter.get("/services", async (req, res) => {
  const db = forShop(req.shop!.id);
  const [services, links] = await Promise.all([
    db.service.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    db.serviceStaff.findMany({ select: { serviceId: true, staffId: true } }),
  ]);
  res.json({
    services: services.map((s) => ({
      ...s,
      price: s.price === null ? null : Number(s.price),
      priceOverrides: s.priceOverrides ?? {},
      durationOverrides: s.durationOverrides ?? {},
      hoursWindows: s.hoursWindows ?? {},
      staffIds: links.filter((l) => l.serviceId === s.id).map((l) => l.staffId),
    })),
  });
});

bookingDashboardRouter.post("/services", async (req, res) => {
  const parsed = serviceSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const db = forShop(req.shop!.id);
  const service = await db.service.create({
    data: {
      name: d.name,
      description: d.description || null,
      imageUrl: d.imageUrl || null,
      durationMin: d.durationMin,
      // Per-weekday overrides ({} = base every day). Stored verbatim; the zod
      // schemas already constrained them to known weekday keys + valid values.
      durationOverrides: d.durationOverrides ?? {},
      hoursWindows: d.hoursWindows ?? {},
      color: d.color ?? null,
      price: d.price ?? null,
      priceOverrides: d.priceOverrides ?? {},
      active: d.active ?? true,
      sortOrder: d.sortOrder ?? 0,
      offeredByAll: d.offeredByAll ?? false,
    },
  });
  // offeredByAll wins: materialize the offering to all active staff and ignore
  // any staffIds. Otherwise honor the hand-picked set.
  if (d.offeredByAll) {
    await linkServiceToAllActiveStaff(req.shop!.id, service.id);
  } else if (d.staffIds) {
    await setServiceStaff(req.shop!.id, service.id, d.staffIds);
  }
  res.status(201).json({ id: service.id });
});

bookingDashboardRouter.patch("/services/:id", async (req, res) => {
  const parsed = serviceSchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const db = forShop(req.shop!.id);
  const { count } = await db.service.updateMany({
    where: { id: req.params.id },
    data: {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.description !== undefined ? { description: d.description || null } : {}),
      ...(d.imageUrl !== undefined ? { imageUrl: d.imageUrl || null } : {}),
      ...(d.durationMin !== undefined ? { durationMin: d.durationMin } : {}),
      ...(d.durationOverrides !== undefined
        ? { durationOverrides: d.durationOverrides }
        : {}),
      ...(d.hoursWindows !== undefined ? { hoursWindows: d.hoursWindows } : {}),
      ...(d.color !== undefined ? { color: d.color } : {}),
      ...(d.price !== undefined ? { price: d.price } : {}),
      ...(d.priceOverrides !== undefined ? { priceOverrides: d.priceOverrides } : {}),
      ...(d.active !== undefined ? { active: d.active } : {}),
      ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
      ...(d.offeredByAll !== undefined ? { offeredByAll: d.offeredByAll } : {}),
    },
  });
  if (count === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Re-materialize the offering to match the (possibly new) mode. If the payload
  // sets offeredByAll true, sync to all active staff and ignore staffIds. If it
  // sets offeredByAll false OR just sends staffIds, use the hand-picked set.
  if (d.offeredByAll === true) {
    await linkServiceToAllActiveStaff(req.shop!.id, req.params.id!);
  } else if (d.staffIds !== undefined) {
    await setServiceStaff(req.shop!.id, req.params.id!, d.staffIds);
  }
  res.json({ ok: true });
});

// Soft-delete (active=false): Appointment.serviceId is Restrict, so history keeps
// a valid FK and a retired service still renders in past appointments.
bookingDashboardRouter.delete("/services/:id", async (req, res) => {
  const db = forShop(req.shop!.id);
  const { count } = await db.service.updateMany({
    where: { id: req.params.id },
    data: { active: false },
  });
  res.json({ ok: count > 0 });
});

/** Replace the staff offering a service (deleteMany + recreate, one tx). */
async function setServiceStaff(
  shopId: string,
  serviceId: string,
  staffIds: string[],
): Promise<void> {
  await runWithShop(shopId, async (tx) => {
    // Only link staff that actually belong to this shop (defensive).
    const valid = await tx.staff.findMany({
      where: { shopId, id: { in: staffIds } },
      select: { id: true },
    });
    await tx.serviceStaff.deleteMany({ where: { shopId, serviceId } });
    if (valid.length > 0) {
      await tx.serviceStaff.createMany({
        data: valid.map((s) => ({ shopId, serviceId, staffId: s.id })),
      });
    }
  });
}

/**
 * Materialize an "offered by all" service's staff links to EVERY currently-active
 * staff member (deleteMany + recreate, one tx). Called when a service is saved as
 * offeredByAll. Keeping the join in sync (rather than teaching every read path a
 * special case) means the slot engine / public page / receptionist are untouched.
 */
async function linkServiceToAllActiveStaff(
  shopId: string,
  serviceId: string,
): Promise<void> {
  await runWithShop(shopId, async (tx) => {
    const active = await tx.staff.findMany({
      where: { shopId, active: true },
      select: { id: true },
    });
    await tx.serviceStaff.deleteMany({ where: { shopId, serviceId } });
    if (active.length > 0) {
      await tx.serviceStaff.createMany({
        data: active.map((s) => ({ shopId, serviceId, staffId: s.id })),
      });
    }
  });
}

/**
 * The other half of "offered by all": when a staff member becomes active (created,
 * or reactivated), link them to every offeredByAll service so "all" stays live.
 * Idempotent - skipDuplicates guards the (serviceId, staffId) unique. This is what
 * makes offeredByAll dynamic for barbers added AFTER a service was created.
 */
async function linkStaffToOfferedByAllServices(
  shopId: string,
  staffId: string,
): Promise<void> {
  await runWithShop(shopId, async (tx) => {
    const services = await tx.service.findMany({
      where: { shopId, offeredByAll: true },
      select: { id: true },
    });
    if (services.length === 0) return;
    await tx.serviceStaff.createMany({
      data: services.map((s) => ({ shopId, serviceId: s.id, staffId })),
      skipDuplicates: true,
    });
  });
}

//  Service add-ons

const addOnSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    durationMin: z.number().int().min(0).max(480),
    price: z.number().min(0).max(100000).nullish(),
    // null/omitted = offered on every service; set = only with that service.
    serviceId: z.string().min(1).nullish(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

bookingDashboardRouter.get("/addons", async (req, res) => {
  const addOns = await forShop(req.shop!.id).serviceAddOn.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  res.json({
    addOns: addOns.map((a) => ({ ...a, price: a.price === null ? null : Number(a.price) })),
  });
});

bookingDashboardRouter.post("/addons", async (req, res) => {
  const parsed = addOnSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const addOn = await forShop(req.shop!.id).serviceAddOn.create({
    data: {
      name: d.name,
      durationMin: d.durationMin,
      price: d.price ?? null,
      serviceId: d.serviceId ?? null,
      active: d.active ?? true,
      sortOrder: d.sortOrder ?? 0,
    },
  });
  res.status(201).json({ id: addOn.id });
});

bookingDashboardRouter.patch("/addons/:id", async (req, res) => {
  const parsed = addOnSchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const { count } = await forShop(req.shop!.id).serviceAddOn.updateMany({
    where: { id: req.params.id },
    data: {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.durationMin !== undefined ? { durationMin: d.durationMin } : {}),
      ...(d.price !== undefined ? { price: d.price ?? null } : {}),
      ...(d.serviceId !== undefined ? { serviceId: d.serviceId ?? null } : {}),
      ...(d.active !== undefined ? { active: d.active } : {}),
      ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
    },
  });
  res.status(count > 0 ? 200 : 404).json({ ok: count > 0 });
});

// Hard delete: add-ons aren't FK'd from Appointment (the choice is snapshotted
// onto Appointment.addOns), so removing one never orphans booking history.
bookingDashboardRouter.delete("/addons/:id", async (req, res) => {
  const { count } = await forShop(req.shop!.id).serviceAddOn.deleteMany({
    where: { id: req.params.id },
  });
  res.json({ ok: count > 0 });
});

//  Staff

const staffSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    bio: z.string().trim().max(500).optional().or(z.literal("")),
    imageUrl: z
      .string()
      .trim()
      .url()
      .max(500)
      .refine((u) => /^https?:\/\//i.test(u), "Must be an http(s) URL")
      .optional()
      .or(z.literal("")),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

bookingDashboardRouter.get("/staff", async (req, res) => {
  const db = forShop(req.shop!.id);
  const staff = await db.staff.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  res.json({ staff });
});

bookingDashboardRouter.post("/staff", async (req, res) => {
  const parsed = staffSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const db = forShop(req.shop!.id);
  const staff = await db.staff.create({
    data: {
      name: d.name,
      bio: d.bio || null,
      imageUrl: d.imageUrl || null,
      active: d.active ?? true,
      sortOrder: d.sortOrder ?? 0,
    },
  });
  // A new ACTIVE barber joins every "offered by all" service automatically -
  // this is what makes offeredByAll a live intent instead of a creation snapshot.
  if (staff.active) {
    await linkStaffToOfferedByAllServices(req.shop!.id, staff.id);
  }
  res.status(201).json({ id: staff.id });
});

bookingDashboardRouter.patch("/staff/:id", async (req, res) => {
  const parsed = staffSchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const db = forShop(req.shop!.id);
  const { count } = await db.staff.updateMany({
    where: { id: req.params.id },
    data: {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.bio !== undefined ? { bio: d.bio || null } : {}),
      ...(d.imageUrl !== undefined ? { imageUrl: d.imageUrl || null } : {}),
      ...(d.active !== undefined ? { active: d.active } : {}),
      ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
    },
  });
  // Reactivating a barber re-joins them to every "offered by all" service (the
  // slot engine ignores inactive staff, so no pruning is needed on deactivation;
  // skipDuplicates makes re-linking an already-linked staff a no-op).
  if (count > 0 && d.active === true) {
    await linkStaffToOfferedByAllServices(req.shop!.id, req.params.id!);
  }
  res.json({ ok: count > 0 });
});

bookingDashboardRouter.delete("/staff/:id", async (req, res) => {
  const db = forShop(req.shop!.id);
  const { count } = await db.staff.updateMany({
    where: { id: req.params.id },
    data: { active: false },
  });
  res.json({ ok: count > 0 });
});

//  Availability (weekly rules + one-off exceptions), per staff

const ruleSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  startMin: z.number().int().min(0).max(1440),
  endMin: z.number().int().min(0).max(1440),
});
// A recurring weekly block-off: same shape as a rule + an optional label.
const blockSchema = ruleSchema.extend({
  reason: z.string().trim().max(200).optional(),
});
const availabilitySchema = z
  .object({
    rules: z.array(ruleSchema).max(100),
    // Recurring weekly block-offs (standing breaks). Replace-all like rules.
    recurringBlocks: z.array(blockSchema).max(100).optional().default([]),
  })
  .strict()
  .refine(
    (d) =>
      d.rules.every((r) => r.endMin > r.startMin) &&
      d.recurringBlocks.every((b) => b.endMin > b.startMin),
    { message: "Each rule/block's end must be after its start." },
  );

bookingDashboardRouter.get("/staff/:id/availability", async (req, res) => {
  const db = forShop(req.shop!.id);
  const staff = await db.staff.findFirst({
    where: { id: req.params.id },
    select: { id: true },
  });
  if (!staff) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const [rules, recurringBlocks, exceptions] = await Promise.all([
    db.availabilityRule.findMany({
      where: { staffId: req.params.id },
      orderBy: [{ weekday: "asc" }, { startMin: "asc" }],
    }),
    db.recurringBlock.findMany({
      where: { staffId: req.params.id },
      orderBy: [{ weekday: "asc" }, { startMin: "asc" }],
    }),
    db.availabilityException.findMany({
      where: { staffId: req.params.id, endsAt: { gt: new Date() } },
      orderBy: { startsAt: "asc" },
    }),
  ]);
  res.json({
    rules: rules.map((r) => ({
      id: r.id,
      weekday: r.weekday,
      startMin: r.startMin,
      endMin: r.endMin,
    })),
    recurringBlocks: recurringBlocks.map((b) => ({
      id: b.id,
      weekday: b.weekday,
      startMin: b.startMin,
      endMin: b.endMin,
      reason: b.reason,
    })),
    exceptions: exceptions.map((e) => ({
      id: e.id,
      startsAt: e.startsAt.toISOString(),
      endsAt: e.endsAt.toISOString(),
      isBlock: e.isBlock,
      reason: e.reason,
    })),
  });
});

// Replace the entire weekly rule set for a staff member in one transaction.
bookingDashboardRouter.put("/staff/:id/availability", async (req, res) => {
  const parsed = availabilitySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const shopId = req.shop!.id;
  const staffId = req.params.id!;
  const ok = await runWithShop(shopId, async (tx) => {
    const staff = await tx.staff.findFirst({
      where: { id: staffId, shopId },
      select: { id: true },
    });
    if (!staff) return false;
    // Replace-all for BOTH rules and recurring blocks, atomically.
    await tx.availabilityRule.deleteMany({ where: { shopId, staffId } });
    if (parsed.data.rules.length > 0) {
      await tx.availabilityRule.createMany({
        data: parsed.data.rules.map((r) => ({ ...r, shopId, staffId })),
      });
    }
    await tx.recurringBlock.deleteMany({ where: { shopId, staffId } });
    if (parsed.data.recurringBlocks.length > 0) {
      await tx.recurringBlock.createMany({
        data: parsed.data.recurringBlocks.map((b) => ({
          weekday: b.weekday,
          startMin: b.startMin,
          endMin: b.endMin,
          reason: b.reason ?? null,
          shopId,
          staffId,
        })),
      });
    }
    return true;
  });
  if (!ok) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});

const exceptionSchema = z
  .object({
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    isBlock: z.boolean().optional(),
    reason: z.string().trim().max(200).optional().or(z.literal("")),
  })
  .strict()
  .refine((d) => d.endsAt > d.startsAt, { message: "End must be after start." });

bookingDashboardRouter.post("/staff/:id/exceptions", async (req, res) => {
  const parsed = exceptionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const db = forShop(req.shop!.id);
  const staff = await db.staff.findFirst({
    where: { id: req.params.id },
    select: { id: true },
  });
  if (!staff) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const d = parsed.data;
  await db.availabilityException.create({
    data: {
      staffId: req.params.id!,
      startsAt: d.startsAt,
      endsAt: d.endsAt,
      isBlock: d.isBlock ?? true,
      reason: d.reason || null,
    },
  });
  res.status(201).json({ ok: true });
});

bookingDashboardRouter.delete("/exceptions/:id", async (req, res) => {
  const db = forShop(req.shop!.id);
  const { count } = await db.availabilityException.deleteMany({
    where: { id: req.params.id },
  });
  res.json({ ok: count > 0 });
});

//  Appointments (the barber's calendar / inbox)

const listQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  staffId: z.string().optional(),
  status: z.enum(["PENDING", "BOOKED", "CANCELED", "COMPLETED", "NO_SHOW"]).optional(),
});

bookingDashboardRouter.get("/appointments", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const q = parsed.data;
  const db = forShop(req.shop!.id);
  const appointments = await db.appointment.findMany({
    where: {
      ...(q.staffId ? { staffId: q.staffId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.from || q.to
        ? { startsAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
        : {}),
      // AI-receptionist holds are PENDING rows but NOT requests - keep them out
      // of the list (esp. the requests inbox). Booking clears holdExpiresAt, so
      // this filter never hides a real appointment.
      holdExpiresAt: null,
    },
    orderBy: { startsAt: "asc" },
    take: 500,
    select: {
      id: true,
      status: true,
      startsAt: true,
      endsAt: true,
      firstName: true,
      lastName: true,
      phone: true,
      email: true,
      staff: { select: { id: true, name: true } },
      service: { select: { id: true, name: true } },
    },
  });
  res.json({
    appointments: appointments.map((a) => ({
      ...a,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
    })),
  });
});

//  Agenda (the day-to-day calendar that works for ANY booking mode)

/**
 * Normalized day-agenda for the barber's calendar. A shop's appointments live in
 * one of two tables depending on how it takes bookings:
 *   - native booking  -> `Appointment` rows (ChairBack's own engine)
 *   - Acuity / Square / link -> `Visit` rows (synced from the source of truth)
 * The `/appointments` endpoint above only reads `Appointment`, so it's empty for
 * every synced shop. This endpoint reads the RIGHT source per `bookingMode` and
 * flattens both into one row shape so the calendar renders identically for all.
 * Read-only for synced shops (we never mutate a Visit the source owns).
 */
type AgendaStatus =
  | "pending"
  | "upcoming"
  | "completed"
  | "canceled"
  | "no_show"
  | "blocked";

interface AgendaRow {
  id: string;
  source: "appointment" | "visit" | "block";
  start: string; // ISO
  end: string | null; // ISO
  clientName: string; // for a block: the reason (or "Blocked")
  serviceName: string | null;
  // Palette key for calendar color-coding; null when the service has no color
  // (or the row is a synced visit / block). See SERVICE_COLORS.
  serviceColor: string | null;
  price: number | null;
  status: AgendaStatus;
  // Non-null when this occurrence is part of a recurring series (native only).
  // Drives the ↻ badge + the "cancel this / future / all" menu on the calendar.
  seriesId: string | null;
  // Check-in sub-state of an upcoming appointment (native only; null on visit/
  // block rows): null | 'en_route' | 'arrived', plus the client's ETA chips.
  // Drives the live pill (Booked -> En route -> Arrived) in the day view.
  checkInStatus: string | null;
  etaMinutes: number | null;
  runningLate: boolean;
  // Nudge affordance (native upcoming rows): whether the client has ANY
  // registered push device ("Notifications off" when false - a nudge won't
  // land), and how many of the max-2 nudges this appointment already used.
  hasPush: boolean;
  nudgesSent: number;
  nudgeLimit: number;
  // Needed by the Apply-reward action (redeem is client-keyed).
  clientId: string | null;
  // The cheapest reward this row's client can afford RIGHT NOW (rewardsEnabled
  // shops only) - drives the "Reward ready - apply to this visit?" prompt.
  // Skipping is a UI dismiss; the reward stays ready until actually applied.
  rewardReady: { rewardId: string; rewardName: string; punchCost: number } | null;
}

const agendaQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  staffId: z.string().optional(),
});

const APPT_STATUS: Record<string, AgendaStatus> = {
  PENDING: "pending", // a request awaiting the barber's approve/decline
  BOOKED: "upcoming",
  COMPLETED: "completed",
  CANCELED: "canceled",
  NO_SHOW: "no_show",
};
// RESCHEDULED -> canceled: the moved slot is defunct; the new time arrives as its
// own SCHEDULED visit, so treating the old row as canceled avoids a phantom.
const VISIT_STATUS: Record<string, AgendaStatus> = {
  SCHEDULED: "upcoming",
  COMPLETED: "completed",
  CANCELED: "canceled",
  NO_SHOW: "no_show",
  RESCHEDULED: "canceled",
};

function fullName(first: string | null, last: string | null): string {
  return `${first ?? ""} ${last ?? ""}`.trim();
}

// forShop() is a hand-curated tenant wrapper that erases nested-relation types
// from a `select`, so we spell out the exact selected shapes and cast to them.
// The cast is safe: it names precisely the fields each `select` below requests.
type ApptAgendaRow = {
  id: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  firstName: string;
  lastName: string | null;
  clientId: string | null;
  priceAtBooking: Prisma.Decimal | null;
  seriesId: string | null;
  checkInStatus: string | null;
  etaMinutes: number | null;
  runningLate: boolean;
  service: { name: string; color: string | null } | null;
};
type VisitAgendaRow = {
  id: string;
  status: string;
  scheduledAt: Date;
  endAt: Date | null;
  price: Prisma.Decimal | null;
  serviceName: string | null;
  client: { firstName: string | null; lastName: string | null } | null;
};

bookingDashboardRouter.get("/agenda", async (req, res) => {
  const parsed = agendaQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const { from, to, staffId } = parsed.data;

  // Shop has RLS with no policy, so bookingMode/timezone must be read as the
  // OWNER (outside forShop), exactly like the /complete handler below.
  const shop = await prisma.shop.findUnique({
    where: { id: req.shop!.id },
    select: { bookingMode: true, timezone: true, rewardsEnabled: true },
  });
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const db = forShop(req.shop!.id);
  let agenda: AgendaRow[];

  if (shop.bookingMode === "native") {
    const rows = (await db.appointment.findMany({
      where: {
        startsAt: { gte: from, lte: to },
        ...(staffId ? { staffId } : {}),
        // Keep AI-receptionist holds off the calendar (see the list above).
        holdExpiresAt: null,
      },
      orderBy: { startsAt: "asc" },
      take: 500,
      select: {
        id: true,
        status: true,
        startsAt: true,
        endsAt: true,
        firstName: true,
        lastName: true,
        clientId: true,
        priceAtBooking: true,
        seriesId: true,
        checkInStatus: true,
        etaMinutes: true,
        runningLate: true,
        service: { select: { name: true, color: true } },
      },
    })) as unknown as ApptAgendaRow[];

    // Nudge affordances, batched: which clients have a push device at all, and
    // how many nudges each appointment already used (max 2, server-enforced).
    const clientIds = [...new Set(rows.map((r) => r.clientId).filter(Boolean))] as string[];
    const pushClients = new Set(
      clientIds.length === 0
        ? []
        : (
            (await db.pushSubscription.findMany({
              where: { clientId: { in: clientIds } },
              select: { clientId: true },
            })) as unknown as { clientId: string | null }[]
          ).map((s) => s.clientId),
    );
    const apptIds = rows.map((r) => r.id);
    const nudgeCounts = new Map<string, number>();
    if (apptIds.length > 0) {
      const nudgeRows = (await db.nudge.findMany({
        // Mirror the engine's cap predicate: FAILED (undelivered) attempts
        // don't consume a nudge, so they mustn't show as used here either.
        where: {
          appointmentId: { in: apptIds },
          kind: APPOINTMENT_NUDGE_KIND,
          status: { in: ["PENDING", "SENT"] },
        },
        select: { appointmentId: true },
      })) as unknown as { appointmentId: string | null }[];
      for (const n of nudgeRows) {
        if (!n.appointmentId) continue;
        nudgeCounts.set(n.appointmentId, (nudgeCounts.get(n.appointmentId) ?? 0) + 1);
      }
    }

    // "Reward ready" prompts (rewardsEnabled shops only): the cheapest active
    // reward each row's client can already afford, per that reward's OWN card
    // balance. Batched: one reward list + one grouped ledger aggregate.
    const rewardReadyByClient = new Map<
      string,
      { rewardId: string; rewardName: string; punchCost: number }
    >();
    if (shop.rewardsEnabled && clientIds.length > 0) {
      const rewardRows = (await db.reward.findMany({
        where: { active: true },
        orderBy: { punchCost: "asc" },
        select: { id: true, name: true, punchCost: true, cardTypeId: true },
      })) as unknown as {
        id: string;
        name: string;
        punchCost: number;
        cardTypeId: string | null;
      }[];
      if (rewardRows.length > 0) {
        const groups = await runWithShop(req.shop!.id, (tx) =>
          tx.punchLedger.groupBy({
            by: ["clientId", "cardTypeId"],
            where: { shopId: req.shop!.id, clientId: { in: clientIds } },
            _sum: { punchesEarned: true, punchesRedeemed: true },
          }),
        );
        const balances = new Map<string, number>();
        for (const g of groups) {
          balances.set(
            `${g.clientId}:${g.cardTypeId ?? ""}`,
            (g._sum.punchesEarned ?? 0) - (g._sum.punchesRedeemed ?? 0),
          );
        }
        for (const clientId of clientIds) {
          const affordable = rewardRows.find(
            (r) =>
              (balances.get(`${clientId}:${r.cardTypeId ?? ""}`) ?? 0) >=
              r.punchCost,
          );
          if (affordable) {
            rewardReadyByClient.set(clientId, {
              rewardId: affordable.id,
              rewardName: affordable.name,
              punchCost: affordable.punchCost,
            });
          }
        }
      }
    }

    agenda = rows.map((a) => ({
      id: a.id,
      source: "appointment" as const,
      start: a.startsAt.toISOString(),
      end: a.endsAt.toISOString(),
      clientName: fullName(a.firstName, a.lastName),
      serviceName: a.service?.name ?? null,
      serviceColor: a.service?.color ?? null,
      price: a.priceAtBooking == null ? null : Number(a.priceAtBooking),
      status: APPT_STATUS[a.status] ?? "upcoming",
      seriesId: a.seriesId,
      checkInStatus: a.checkInStatus,
      etaMinutes: a.etaMinutes,
      runningLate: a.runningLate,
      hasPush: a.clientId !== null && pushClients.has(a.clientId),
      nudgesSent: nudgeCounts.get(a.id) ?? 0,
      nudgeLimit: APPOINTMENT_NUDGE_LIMIT,
      clientId: a.clientId,
      rewardReady:
        a.clientId !== null
          ? (rewardReadyByClient.get(a.clientId) ?? null)
          : null,
    }));

    // Blocked time (barber "Block Off Time") shows on the calendar too, as
    // distinct rows so the day view reflects when the chair is unavailable.
    const blocks = (await db.availabilityException.findMany({
      where: {
        isBlock: true,
        startsAt: { gte: from, lte: to },
        ...(staffId ? { staffId } : {}),
      },
      orderBy: { startsAt: "asc" },
      take: 200,
      select: { id: true, startsAt: true, endsAt: true, reason: true },
    })) as unknown as {
      id: string;
      startsAt: Date;
      endsAt: Date;
      reason: string | null;
    }[];
    for (const b of blocks) {
      agenda.push({
        id: b.id,
        source: "block",
        start: b.startsAt.toISOString(),
        end: b.endsAt.toISOString(),
        clientName: b.reason || "Blocked",
        serviceName: null,
        serviceColor: null,
        price: null,
        status: "blocked",
        seriesId: null,
        checkInStatus: null,
        etaMinutes: null,
        runningLate: false,
        hasPush: false,
        nudgesSent: 0,
        nudgeLimit: APPOINTMENT_NUDGE_LIMIT,
        clientId: null,
        rewardReady: null,
      });
    }
    agenda.sort((a, b) => a.start.localeCompare(b.start));
  } else {
    // Synced shops (Acuity / Square / link): appointments are Visit rows. There's
    // no staff relation on Visit, so a staffId filter simply doesn't apply.
    const rows = (await db.visit.findMany({
      where: { scheduledAt: { gte: from, lte: to } },
      orderBy: { scheduledAt: "asc" },
      take: 500,
      select: {
        id: true,
        status: true,
        scheduledAt: true,
        endAt: true,
        price: true,
        serviceName: true,
        client: { select: { firstName: true, lastName: true } },
      },
    })) as unknown as VisitAgendaRow[];
    agenda = rows.map((v) => ({
      id: v.id,
      source: "visit" as const,
      start: v.scheduledAt.toISOString(),
      end: v.endAt ? v.endAt.toISOString() : null,
      clientName: fullName(v.client?.firstName ?? null, v.client?.lastName ?? null),
      serviceName: v.serviceName ?? null,
      serviceColor: null, // Visits have no linked Service row (synced shops).
      price: v.price == null ? null : Number(v.price),
      status: VISIT_STATUS[v.status] ?? "upcoming",
      seriesId: null,
      checkInStatus: null,
      etaMinutes: null,
      runningLate: false,
      hasPush: false,
      nudgesSent: 0,
      nudgeLimit: APPOINTMENT_NUDGE_LIMIT,
      clientId: null,
      rewardReady: null,
    }));
  }

  res.json({
    agenda,
    source: shop.bookingMode === "native" ? "appointment" : "visit",
    timezone: shop.timezone,
  });
});

//  Create an appointment FROM THE DASHBOARD (barber-side "New Appointment")

/**
 * The barber schedules an appointment directly on their calendar. Native-only:
 * an Appointment needs a Staff + Service, which Acuity/Square shops don't have.
 * Mirrors the public create tx (slot lock + overlap check + client upsert), but:
 *  - it's authenticated (the shop comes from the session, not a slug),
 *  - `customTime` lets the barber force a time outside computed availability
 *    (their own calendar - Acuity's "Custom Time"), while still preventing a
 *    real double-booking via the overlap check,
 *  - the client can be an existing one (clientId) or created inline from a name.
 */
const createApptSchema = z
  .object({
    staffId: z.string().min(1),
    serviceId: z.string().min(1),
    startsAt: z.coerce.date(),
    clientId: z.string().min(1).optional(),
    firstName: z.string().trim().max(80).optional().or(z.literal("")),
    lastName: z.string().trim().max(80).optional().or(z.literal("")),
    phone: z.string().trim().max(40).optional().or(z.literal("")),
    email: z.string().trim().email().max(200).optional().or(z.literal("")),
    note: z.string().trim().max(1000).optional().or(z.literal("")),
    // Bypass the availability check (barber forcing a time). Overlap is still
    // enforced so two real appointments can't collide.
    customTime: z.boolean().optional(),
    // Chosen service add-ons (ids). Extend the appointment length + total; the
    // choice is snapshotted. Invalid/foreign ids are dropped server-side.
    addOnIds: z.array(z.string().min(1)).max(20).optional(),
    // Optional "repeats every N weeks" rule. When present, the appointment above
    // is occurrence 0 (its startsAt sets the weekday + time-of-day), and N-1 more
    // are generated. Exactly one of count / until. Capped so a bad rule can't
    // generate a runaway series.
    recurrence: z
      .object({
        interval: z.number().int().min(1).max(8),
        count: z.number().int().min(2).max(52).optional(),
        until: z.coerce.date().optional(),
      })
      .strict()
      .refine((r) => (r.count == null) !== (r.until == null), {
        message: "Set exactly one of count or until.",
      })
      .optional(),
  })
  .strict()
  // Either pick an existing client, or give a name to create one.
  .refine((d) => Boolean(d.clientId) || Boolean(d.firstName?.trim()), {
    message: "Pick a client or enter a name.",
    path: ["clientId"],
  });

/**
 * Resolve the client for a recurring series ONCE (before generating occurrences)
 * - either an existing client, or an inline upsert from the typed name. Mirrors
 * the inline resolution in the single-create tx but standalone. Returns the id +
 * the name snapshot to copy onto each occurrence, or null if a given clientId
 * doesn't belong to the shop.
 */
async function resolveSeriesClient(input: {
  shopId: string;
  clientId: string | null;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  email: string | null;
}): Promise<{ clientId: string; firstName: string; lastName: string | null } | null> {
  if (input.clientId) {
    const existing = await prisma.client.findFirst({
      where: { id: input.clientId, shopId: input.shopId },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!existing) return null;
    return {
      clientId: existing.id,
      firstName: existing.firstName || input.firstName || "Client",
      lastName: existing.lastName ?? input.lastName,
    };
  }
  const acuityClientKey = deriveAcuityClientKey({
    phone: input.phone ?? undefined,
    email: input.email ?? undefined,
    firstName: input.firstName,
    lastName: input.lastName ?? undefined,
  });
  const client = await prisma.client.upsert({
    where: { shopId_acuityClientKey: { shopId: input.shopId, acuityClientKey } },
    create: {
      shopId: input.shopId,
      acuityClientKey,
      magicToken: randomToken(),
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      email: input.email,
      source: "manual",
    },
    update: {
      firstName: input.firstName || undefined,
      lastName: input.lastName || undefined,
      phone: input.phone ?? undefined,
      email: input.email || undefined,
    },
    select: { id: true },
  });
  return {
    clientId: client.id,
    firstName: input.firstName || "Client",
    lastName: input.lastName,
  };
}

bookingDashboardRouter.post("/appointments", async (req, res) => {
  const parsed = createApptSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const shopId = req.shop!.id;
  // Read shop as owner (RLS: Shop has no policy) for bookingMode/timezone/bounds.
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true, bookingMode: true, timezone: true, bookingBufferMin: true },
  });
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (shop.bookingMode !== "native") {
    // Acuity/Square/link: the appointment lives in that system, not here.
    res.status(400).json({ error: "not_native" });
    return;
  }
  const d = parsed.data;

  // Validate the staff offers an active service; compute end + snapshot price.
  const service = await prisma.service.findFirst({
    where: { id: d.serviceId, shopId, active: true },
    select: {
      id: true,
      durationMin: true,
      durationOverrides: true,
      price: true,
      priceOverrides: true,
      name: true,
    },
  });
  const offering = await prisma.serviceStaff.findFirst({
    where: { shopId, serviceId: d.serviceId, staffId: d.staffId },
    select: { id: true },
  });
  const staff = await prisma.staff.findFirst({
    where: { id: d.staffId, shopId, active: true },
    select: { id: true },
  });
  if (!service || !offering || !staff) {
    res.status(400).json({ error: "invalid_slot" });
    return;
  }

  const startsAt = d.startsAt;
  // Chosen add-ons extend the appointment + total (single create only; a
  // recurring series is barber-planned and takes no add-ons in v1).
  const addOns = d.recurrence
    ? { snapshot: [], extraDurationMin: 0, extraPrice: 0 }
    : await resolveAddOns(shopId, d.serviceId, d.addOnIds);
  // Effective duration for the picked date's shop-local weekday (mirrors the
  // effectivePriceForDate snapshot just below).
  const effectiveDuration = effectiveDurationForDate(
    service.durationMin,
    service.durationOverrides,
    startsAt,
    shop.timezone,
  );
  const endsAt = new Date(
    startsAt.getTime() + (effectiveDuration + addOns.extraDurationMin) * 60_000,
  );
  const basePrice = effectivePriceForDate(
    service.price === null ? null : Number(service.price),
    service.priceOverrides,
    startsAt,
    shop.timezone,
  );
  const effectivePrice =
    basePrice === null && addOns.extraPrice === 0
      ? null
      : (basePrice ?? 0) + addOns.extraPrice;

  // Unless the barber forced a custom time, the slot must be genuinely bookable
  // (inside hours, not blocked). Overlap is always enforced below regardless.
  if (
    !d.customTime &&
    !(await isSlotBookable({
      shopId,
      staffId: d.staffId,
      serviceId: d.serviceId,
      startsAt,
      extraDurationMin: addOns.extraDurationMin,
    }))
  ) {
    res.status(400).json({ error: "invalid_slot" });
    return;
  }

  const phone = toE164(d.phone);
  if (d.phone?.trim() && !phone) {
    res.status(400).json({ error: "invalid_phone" });
    return;
  }

  try {
    // RECURRING: build the whole series (occurrence 0 included). The client is
    // upserted once, then materializeSeries generates each occurrence in its own
    // tx (per-occurrence overlap guard, skip-and-report). customTime skips the
    // per-occurrence bounds/availability check for the barber-forced case.
    if (d.recurrence) {
      const resolved = await resolveSeriesClient({
        shopId,
        clientId: d.clientId ?? null,
        firstName: d.firstName?.trim() || "",
        lastName: d.lastName?.trim() || null,
        phone,
        email: d.email || null,
      });
      if (!resolved) {
        res.status(404).json({ error: "client_not_found" });
        return;
      }
      const parts = zonedDateParts(startsAt, shop.timezone);
      const startMin = localMinutesOfDay(startsAt, shop.timezone);
      const pattern: RecurrencePattern = {
        interval: d.recurrence.interval,
        weekday: parts.weekday,
        startMin,
        count: d.recurrence.count,
        untilDate: d.recurrence.until,
      };
      const series = await materializeSeries({
        shopId,
        staffId: d.staffId,
        serviceId: d.serviceId,
        clientId: resolved.clientId,
        firstName: resolved.firstName,
        lastName: resolved.lastName,
        phone,
        email: d.email || null,
        durationMin: service.durationMin,
        durationOverrides: service.durationOverrides,
        basePrice: service.price === null ? null : Number(service.price),
        priceOverrides: service.priceOverrides,
        timezone: shop.timezone,
        bookingBufferMin: shop.bookingBufferMin,
        // customTime bypasses the per-occurrence availability gate (barber force).
        checkAvailability: !d.customTime,
        pattern,
        anchor: startsAt,
      });
      res.status(201).json({
        ok: true,
        id: series.booked[0]?.appointmentId ?? null,
        series: {
          id: series.seriesId,
          booked: series.booked.length,
          skipped: series.skipped.map((s) => ({
            startsAt: s.startsAt.toISOString(),
            reason: s.reason,
          })),
        },
      });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      // Shared advisory-lock + overlap guard (same as the public create);
      // SlotTakenError's message is "slot_taken", so the catch below matches.
      await lockStaffAndAssertSlotFree(tx, {
        staffId: d.staffId,
        startsAt,
        endsAt,
        bufferMin: shop.bookingBufferMin,
      });

      // Resolve the client: an existing one, or create inline from the name.
      let clientId = d.clientId ?? null;
      let cFirst = d.firstName?.trim() || "";
      let cLast = d.lastName?.trim() || null;
      if (clientId) {
        const existing = await tx.client.findFirst({
          where: { id: clientId, shopId },
          select: { id: true, firstName: true, lastName: true },
        });
        if (!existing) throw new Error("client_not_found");
        cFirst = existing.firstName ?? cFirst;
        cLast = existing.lastName ?? cLast;
      } else {
        const acuityClientKey = deriveAcuityClientKey({
          phone: d.phone,
          email: d.email,
          firstName: cFirst,
          lastName: cLast ?? undefined,
        });
        const client = await tx.client.upsert({
          where: { shopId_acuityClientKey: { shopId, acuityClientKey } },
          create: {
            shopId,
            acuityClientKey,
            magicToken: randomToken(),
            firstName: cFirst,
            lastName: cLast,
            phone,
            email: d.email || null,
            source: "manual",
          },
          update: {
            firstName: cFirst || undefined,
            lastName: cLast || undefined,
            phone: phone ?? undefined,
            email: d.email || undefined,
          },
          select: { id: true },
        });
        clientId = client.id;
      }

      const appt = await tx.appointment.create({
        data: {
          shopId,
          staffId: d.staffId,
          serviceId: d.serviceId,
          clientId,
          firstName: cFirst || "Client",
          lastName: cLast,
          phone,
          email: d.email || null,
          status: "BOOKED",
          startsAt,
          endsAt,
          priceAtBooking: effectivePrice ?? undefined,
          addOns: addOns.snapshot as unknown as Prisma.InputJsonValue,
          manageToken: randomToken(),
        },
        select: { id: true },
      });
      return appt;
    });
    res.status(201).json({ ok: true, id: result.id });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "slot_taken") {
      res.status(409).json({ error: "slot_taken" });
      return;
    }
    if (msg === "client_not_found") {
      res.status(404).json({ error: "client_not_found" });
      return;
    }
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      res.status(409).json({ error: "slot_taken" });
      return;
    }
    logger.error({ err, shopId }, "dashboard appointment create failed");
    res.status(500).json({ error: "create_failed" });
  }
});

// Open slots for the barber's "New Appointment" Time picker (native only). Same
// engine as the public slots route, but authenticated + shop-from-session.
const dashSlotsSchema = z.object({
  staffId: z.string().min(1),
  serviceId: z.string().min(1),
  from: z.coerce.date(),
  to: z.coerce.date(),
});

bookingDashboardRouter.get("/slots", async (req, res) => {
  const parsed = dashSlotsSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const shopId = req.shop!.id;
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { bookingMode: true, timezone: true },
  });
  if (!shop || shop.bookingMode !== "native") {
    res.status(400).json({ error: "not_native" });
    return;
  }
  const slots = await computeOpenSlots({
    shopId,
    staffId: parsed.data.staffId,
    serviceId: parsed.data.serviceId,
    fromDate: parsed.data.from,
    toDate: parsed.data.to,
    now: new Date(),
  });
  res.json({
    timezone: shop.timezone,
    slots: slots.map((s) => ({
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
    })),
  });
});

bookingDashboardRouter.post("/appointments/:id/cancel", async (req, res) => {
  const ok = await cancelAppointment(req.shop!.id, req.params.id!, "CANCELED");
  res.status(ok ? 200 : 404).json({ ok });
});

bookingDashboardRouter.post("/appointments/:id/no-show", async (req, res) => {
  const shopId = req.shop!.id;
  // A no-show only applies to a CONFIRMED booking - a never-approved PENDING
  // request can't be a no-show (decline it instead). Reject non-BOOKED.
  const appt = await forShop(shopId).appointment.findFirst({
    where: { id: req.params.id!, shopId },
    select: { status: true },
  });
  if (!appt) {
    res.status(404).json({ ok: false });
    return;
  }
  if (appt.status !== "BOOKED") {
    res.status(409).json({ ok: false, error: "not_booked" });
    return;
  }
  const ok = await cancelAppointment(shopId, req.params.id!, "NO_SHOW");
  res.status(ok ? 200 : 404).json({ ok });
});

//  Targeted slots (one-off special-priced bookable slots under a service)

const targetedSlotSchema = z
  .object({
    staffId: z.string().min(1),
    serviceId: z.string().min(1),
    label: z.string().trim().max(60).optional().or(z.literal("")),
    startsAt: z.coerce.date().refine((dt) => !Number.isNaN(dt.getTime())),
    durationMin: z.number().int().min(5).max(600),
    price: z.number().min(0).max(100000),
    // Weekly recurrence, materialized at creation: 0 = just this one; N = this
    // one + N more weeks at the same shop-local wall time (DST-stable).
    repeatWeeks: z.number().int().min(0).max(26).optional(),
  })
  .strict();

bookingDashboardRouter.get("/targeted-slots", async (req, res) => {
  const db = forShop(req.shop!.id);
  const slots = (await db.targetedSlot.findMany({
    where: { startsAt: { gt: new Date() } },
    orderBy: { startsAt: "asc" },
    take: 200,
    select: {
      id: true,
      staffId: true,
      serviceId: true,
      label: true,
      startsAt: true,
      durationMin: true,
      price: true,
      active: true,
      bookedAppointmentId: true,
    },
  })) as unknown as {
    id: string;
    staffId: string;
    serviceId: string;
    label: string | null;
    startsAt: Date;
    durationMin: number;
    price: Prisma.Decimal;
    active: boolean;
    bookedAppointmentId: string | null;
  }[];
  res.json({
    targetedSlots: slots.map((t) => ({
      ...t,
      startsAt: t.startsAt.toISOString(),
      price: Number(t.price),
      booked: t.bookedAppointmentId !== null,
    })),
  });
});

bookingDashboardRouter.post("/targeted-slots", async (req, res) => {
  const parsed = targetedSlotSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const shopId = req.shop!.id;
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { timezone: true, bookingMode: true },
  });
  if (!shop || shop.bookingMode !== "native") {
    res.status(400).json({ error: "not_native" });
    return;
  }
  if (d.startsAt.getTime() <= Date.now()) {
    res.status(400).json({ error: "in_the_past" });
    return;
  }
  const db = forShop(shopId);
  const [service, staff] = await Promise.all([
    db.service.findFirst({ where: { id: d.serviceId, active: true }, select: { id: true } }),
    db.staff.findFirst({ where: { id: d.staffId, active: true }, select: { id: true } }),
  ]);
  if (!service || !staff) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }

  // Materialize the weekly repeats at the SAME shop-local wall time (a naive
  // +7d of the UTC instant would drift an hour across a DST change).
  const anchor = zonedDateParts(d.startsAt, shop.timezone);
  const wallMin = localMinutesOfDay(d.startsAt, shop.timezone);
  const rows = [];
  for (let week = 0; week <= (d.repeatWeeks ?? 0); week++) {
    const startsAt =
      week === 0
        ? d.startsAt
        : zonedWallTimeToUtc(
            anchor.year,
            anchor.month0,
            anchor.day + week * 7, // Date.UTC in the helper normalizes overflow
            wallMin,
            shop.timezone,
          );
    rows.push({
      staffId: d.staffId,
      serviceId: d.serviceId,
      label: d.label?.trim() || null,
      startsAt,
      durationMin: d.durationMin,
      price: d.price,
    });
  }
  await db.targetedSlot.createMany({ data: rows });
  res.status(201).json({ ok: true, created: rows.length });
});

// Delete an UNBOOKED targeted slot (a booked one is history - 409).
bookingDashboardRouter.delete("/targeted-slots/:id", async (req, res) => {
  const db = forShop(req.shop!.id);
  const { count } = await db.targetedSlot.deleteMany({
    where: { id: req.params.id, bookedAppointmentId: null },
  });
  if (count === 0) {
    const exists = await db.targetedSlot.count({ where: { id: req.params.id } });
    res.status(exists > 0 ? 409 : 404).json({ ok: false });
    return;
  }
  res.json({ ok: true });
});

// Barber -> client "come early" push nudge on one appointment. Max 2 per
// appointment, enforced in the engine under an advisory lock (server-side, not
// just UI). 402-free: push costs nothing and never counts against SMS caps.
const nudgeSchema = z.object({ body: z.string().min(1).max(140) }).strict();

bookingDashboardRouter.post("/appointments/:id/nudge", async (req, res) => {
  const parsed = nudgeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  try {
    const result = await sendAppointmentNudge({
      shopId: req.shop!.id,
      appointmentId: req.params.id!,
      body: parsed.data.body.trim(),
    });
    if (!result.ok) {
      res.status(404).json({ ok: false });
      return;
    }
    // delivered:false = the client has no registered push device. The nudge is
    // still logged (FAILED) and counts toward the cap - surfaced so the barber
    // knows it won't land.
    res.json({ ok: true, delivered: result.delivered });
  } catch (err) {
    if (err instanceof NudgeLimitError) {
      res.status(429).json({ ok: false, error: "nudge_limit" });
      return;
    }
    logger.error({ err, shopId: req.shop!.id }, "appointment nudge failed");
    res.status(500).json({ ok: false, error: "nudge_failed" });
  }
});

// Mark the client as physically in the chair/shop. Barber-only counterpart to
// the public "On my way" check-in (which can only ever write 'en_route'); works
// from ANY prior check-in state because walk-ins arrive without tapping the
// button. checkedInAt is deliberately untouched - it records the CLIENT's tap,
// not the barber's confirmation.
bookingDashboardRouter.post("/appointments/:id/arrived", async (req, res) => {
  const shopId = req.shop!.id;
  const updated = await forShop(shopId).appointment.updateMany({
    where: { id: req.params.id!, shopId, status: "BOOKED" },
    data: { checkInStatus: "arrived" },
  });
  res.status(updated.count > 0 ? 200 : 404).json({ ok: updated.count > 0 });
});

// Approve a PENDING request (request-before-booking): flip it to BOOKED in place
// and fire the customer's confirmation. Re-checks the slot is still free (a
// concurrent booking may have taken it) under the per-staff advisory lock.
bookingDashboardRouter.post("/appointments/:id/approve", async (req, res) => {
  const shopId = req.shop!.id;
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { bookingBufferMin: true },
  });
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  try {
    const approved = await runWithShop(shopId, async (tx) => {
      const appt = await tx.appointment.findFirst({
        // holdExpiresAt null: an AI-receptionist HOLD is also PENDING but is
        // not a request - it must never be approvable (it's already excluded
        // from the requests list; this is the belt-and-suspenders).
        where: { id: req.params.id!, shopId, status: "PENDING", holdExpiresAt: null },
        select: { id: true, staffId: true, startsAt: true, endsAt: true },
      });
      if (!appt) return null; // not found / already handled (idempotent)

      // Re-verify under the shared guard, excluding self. BOOKED-only: the row
      // being approved is itself PENDING, and any conflicting PENDING would
      // have failed its own create guard (see engines/bookingWrite.ts).
      await lockStaffAndAssertSlotFree(tx, {
        staffId: appt.staffId,
        startsAt: appt.startsAt,
        endsAt: appt.endsAt,
        bufferMin: shop.bookingBufferMin,
        excludeAppointmentId: appt.id,
        statuses: ["BOOKED"],
      });

      await tx.appointment.update({
        where: { id: appt.id },
        data: { status: "BOOKED" },
      });
      return appt.id;
    });
    if (!approved) {
      res.status(404).json({ ok: false });
      return;
    }
    // First customer confirmation fires now (approval is the confirm event).
    void notifyAppointmentConfirmation({ shopId, appointmentId: approved });
    res.status(200).json({ ok: true });
  } catch (err) {
    if ((err as Error).message === "slot_taken") {
      res.status(409).json({ ok: false, error: "slot_taken" });
      return;
    }
    logger.error({ err, shopId }, "approve appointment failed");
    res.status(500).json({ ok: false, error: "approve_failed" });
  }
});

// Decline a PENDING request: a LIGHT terminal flip to CANCELED. Deliberately NOT
// routed through cancelAppointment - nothing was ever confirmed, so there's no
// payment to refund, no Visit to claw back, and firing a "slot opened" waitlist
// blast for a slot no one really held would be wrong.
bookingDashboardRouter.post("/appointments/:id/decline", async (req, res) => {
  const shopId = req.shop!.id;
  const updated = await forShop(shopId).appointment.updateMany({
    where: { id: req.params.id!, shopId, status: "PENDING" },
    data: { status: "CANCELED", canceledAt: new Date() },
  });
  if (updated.count > 0) {
    // A targeted-slot REQUEST claims its slot at create time (capacity 1 must
    // hold while the request waits). Declining means the barber never accepted
    // it, so the claim is RELEASED and the special slot goes back on sale -
    // unlike a real (approved/booked) cancellation, which keeps it consumed.
    await forShop(shopId).targetedSlot.updateMany({
      where: { bookedAppointmentId: req.params.id! },
      data: { bookedAppointmentId: null },
    });
  }
  res.status(updated.count > 0 ? 200 : 404).json({ ok: updated.count > 0 });
});

// Cancel a recurring series by scope: "this" one occurrence, "future" (this and
// all later), or "all" (every still-booked occurrence). "this"/"future" need the
// anchor occurrence's id. Each canceled row refunds/claws-back on its own.
const cancelSeriesSchema = z
  .object({
    scope: z.enum(["this", "future", "all"]),
    fromAppointmentId: z.string().min(1).optional(),
  })
  .strict()
  .refine((d) => d.scope === "all" || Boolean(d.fromAppointmentId), {
    message: "fromAppointmentId is required for 'this' and 'future'.",
    path: ["fromAppointmentId"],
  });

bookingDashboardRouter.post("/series/:id/cancel", async (req, res) => {
  const parsed = cancelSeriesSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const result = await cancelSeries(
    req.shop!.id,
    req.params.id!,
    parsed.data.scope as CancelSeriesScope,
    parsed.data.fromAppointmentId,
  );
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.status(200).json({ ok: true, ...result });
});

// Mark an appointment done NOW (earn the punch while the client is still in the
// chair) - reuses the SAME promotion path the scheduled job runs.
bookingDashboardRouter.post("/appointments/:id/complete", async (req, res) => {
  const shopId = req.shop!.id;
  const now = new Date();
  // Shop has RLS enabled (no policy) so the app role inside runWithShop can't
  // read it - load it as the owner BEFORE the tx, like the scheduled job does.
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true, punchesPerVisit: true },
  });
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const result = await runWithShop(shopId, async (tx) => {
    const appt = await tx.appointment.findFirst({
      where: { id: req.params.id, shopId, status: "BOOKED" },
      select: {
        id: true,
        clientId: true,
        startsAt: true,
        endsAt: true,
        priceAtBooking: true,
        service: { select: { name: true } },
      },
    });
    if (!appt || !appt.clientId) return null;
    const earn = await promoteOneAppointmentInTx(
      tx,
      shop,
      {
        id: appt.id,
        clientId: appt.clientId,
        startsAt: appt.startsAt,
        endsAt: appt.endsAt,
        priceAtBooking: appt.priceAtBooking,
        serviceName: appt.service?.name ?? null,
      },
      now,
    );
    return { clientId: appt.clientId, earn };
  });

  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await recomputeCadence(shopId, result.clientId);
  if (result.earn) {
    void notifyPunchEarned({
      shopId,
      clientId: result.clientId,
      earned: result.earn.earned,
      balance: result.earn.balance,
      cardTypeId: result.earn.cardTypeId,
      cardName: result.earn.cardName,
      now,
    });
  }
  res.json({ ok: true });
});
