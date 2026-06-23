import { Router } from "express";
import { z } from "zod";
import { forShop, prisma, runWithShop } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import {
  cancelAppointment,
  promoteOneAppointmentInTx,
} from "../engines/appointmentPromotion.js";
import { recomputeCadence } from "../engines/cadence.js";
import { notifyPunchEarned } from "../services/loyaltyNotify.js";

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

const serviceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional().or(z.literal("")),
    durationMin: z.number().int().min(5).max(600),
    price: z.number().min(0).max(100000).nullable().optional(),
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

bookingDashboardRouter.post("/appointments/:id/cancel", async (req, res) => {
  const ok = await cancelAppointment(req.shop!.id, req.params.id!, "CANCELED");
  res.status(ok ? 200 : 404).json({ ok });
});

bookingDashboardRouter.post("/appointments/:id/no-show", async (req, res) => {
  const ok = await cancelAppointment(req.shop!.id, req.params.id!, "NO_SHOW");
  res.status(ok ? 200 : 404).json({ ok });
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
      now,
    });
  }
  res.json({ ok: true });
});
