import { Router } from "express";
import { z } from "zod";
import { randomToken } from "@chairback/config";
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
import { deriveAcuityClientKey, toE164 } from "../acuity/clientKey.js";
import { computeOpenSlots, isSlotBookable } from "../engines/slots.js";
import { effectivePriceForDate } from "../engines/pricing.js";
import {
  materializeSeries,
  type RecurrencePattern,
} from "../engines/recurringSeries.js";
import { zonedDateParts, localMinutesOfDay } from "@chairback/config";
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

const serviceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional().or(z.literal("")),
    durationMin: z.number().int().min(5).max(600),
    price: z.number().min(0).max(100000).nullable().optional(),
    priceOverrides: priceOverridesSchema,
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    // Which staff offer this service (ids). Replaces the offering set on write.
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
      durationMin: d.durationMin,
      price: d.price ?? null,
      // Per-weekday overrides ({} = base price every day). Stored verbatim; the
      // zod schema already constrained it to known weekday keys + valid prices.
      priceOverrides: d.priceOverrides ?? {},
      active: d.active ?? true,
      sortOrder: d.sortOrder ?? 0,
    },
  });
  if (d.staffIds) await setServiceStaff(req.shop!.id, service.id, d.staffIds);
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
      ...(d.durationMin !== undefined ? { durationMin: d.durationMin } : {}),
      ...(d.price !== undefined ? { price: d.price } : {}),
      ...(d.priceOverrides !== undefined ? { priceOverrides: d.priceOverrides } : {}),
      ...(d.active !== undefined ? { active: d.active } : {}),
      ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
    },
  });
  if (count === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (d.staffIds !== undefined) {
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
const availabilitySchema = z
  .object({ rules: z.array(ruleSchema).max(100) })
  .strict()
  .refine((d) => d.rules.every((r) => r.endMin > r.startMin), {
    message: "Each rule's end must be after its start.",
  });

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
  const [rules, exceptions] = await Promise.all([
    db.availabilityRule.findMany({
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
    await tx.availabilityRule.deleteMany({ where: { shopId, staffId } });
    if (parsed.data.rules.length > 0) {
      await tx.availabilityRule.createMany({
        data: parsed.data.rules.map((r) => ({ ...r, shopId, staffId })),
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
  status: z.enum(["BOOKED", "CANCELED", "COMPLETED", "NO_SHOW"]).optional(),
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
type AgendaStatus = "upcoming" | "completed" | "canceled" | "no_show" | "blocked";

interface AgendaRow {
  id: string;
  source: "appointment" | "visit" | "block";
  start: string; // ISO
  end: string | null; // ISO
  clientName: string; // for a block: the reason (or "Blocked")
  serviceName: string | null;
  price: number | null;
  status: AgendaStatus;
  // Non-null when this occurrence is part of a recurring series (native only).
  // Drives the ↻ badge + the "cancel this / future / all" menu on the calendar.
  seriesId: string | null;
}

const agendaQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  staffId: z.string().optional(),
});

const APPT_STATUS: Record<string, AgendaStatus> = {
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
  priceAtBooking: Prisma.Decimal | null;
  seriesId: string | null;
  service: { name: string } | null;
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
    select: { bookingMode: true, timezone: true },
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
        priceAtBooking: true,
        seriesId: true,
        service: { select: { name: true } },
      },
    })) as unknown as ApptAgendaRow[];
    agenda = rows.map((a) => ({
      id: a.id,
      source: "appointment" as const,
      start: a.startsAt.toISOString(),
      end: a.endsAt.toISOString(),
      clientName: fullName(a.firstName, a.lastName),
      serviceName: a.service?.name ?? null,
      price: a.priceAtBooking == null ? null : Number(a.priceAtBooking),
      status: APPT_STATUS[a.status] ?? "upcoming",
      seriesId: a.seriesId,
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
        price: null,
        status: "blocked",
        seriesId: null,
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
      price: v.price == null ? null : Number(v.price),
      status: VISIT_STATUS[v.status] ?? "upcoming",
      seriesId: null,
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
    select: { id: true, durationMin: true, price: true, priceOverrides: true, name: true },
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
  const endsAt = new Date(startsAt.getTime() + service.durationMin * 60_000);
  const effectivePrice = effectivePriceForDate(
    service.price === null ? null : Number(service.price),
    service.priceOverrides,
    startsAt,
    shop.timezone,
  );

  // Unless the barber forced a custom time, the slot must be genuinely bookable
  // (inside hours, not blocked). Overlap is always enforced below regardless.
  if (
    !d.customTime &&
    !(await isSlotBookable({ shopId, staffId: d.staffId, serviceId: d.serviceId, startsAt }))
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
      // Serialize concurrent grabs on this staff's calendar, then overlap-check
      // with the turnover buffer (same guard as the public create).
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`appt:${d.staffId}`}))`,
      );
      const bufferMs = Math.max(0, shop.bookingBufferMin) * 60_000;
      const overlapStart = new Date(startsAt.getTime() - bufferMs);
      const overlapEnd = new Date(endsAt.getTime() + bufferMs);
      const overlap = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM "Appointment"
                   WHERE "staffId" = ${d.staffId}
                     AND "status" = 'BOOKED'
                     AND "startsAt" < ${overlapEnd}
                     AND "endsAt" > ${overlapStart}`,
      );
      if (overlap.length > 0) throw new Error("slot_taken");

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
  const ok = await cancelAppointment(req.shop!.id, req.params.id!, "NO_SHOW");
  res.status(ok ? 200 : 404).json({ ok });
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
