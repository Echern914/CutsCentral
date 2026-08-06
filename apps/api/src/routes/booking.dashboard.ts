import { Router } from "express";
import { z } from "zod";
import { randomToken, SERVICE_COLOR_KEYS } from "@chairback/config";
import { forShop, prisma, Prisma, runWithShop } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireManager } from "../auth/roles.js";
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
import {
  effectiveSchedule,
  materializeTargetedRule,
  TARGETED_RULE_HORIZON_DAYS,
  type RuleSchedule,
} from "../engines/targetedSlotRules.js";
import { effectiveDurationAt, effectivePriceAt } from "../engines/pricing.js";
import {
  materializeSeries,
  type RecurrencePattern,
} from "../engines/recurringSeries.js";
import { zonedDateParts, zonedWallTimeToUtc, localMinutesOfDay } from "@chairback/config";
import { invalidateShopAvailabilityCaches } from "./booking.public.js";
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
bookingDashboardRouter.use(requireUser, requireShop, requireManager);

/**
 * Any successful mutation here can change what the public booking page offers
 * (hours, services, groups, staff, block-offs, targeted slots, booking rules,
 * a manually-booked appointment). The public /day + /open-days responses are
 * cached in-process for 60s, so without this the barber's own verify loop —
 * save, then immediately open the booking page — shows him PRE-SAVE times and
 * reads as "it didn't save".
 *
 * One router-level hook instead of ~15 per-route calls: a new mutating route
 * can't forget to invalidate. Fires after the response is sent (never delays
 * the barber's save) and only on a 2xx/3xx, so a rejected write doesn't dump a
 * warm cache. Deliberately broad — invalidation is one Map delete, while a
 * missed one costs a support text.
 */
bookingDashboardRouter.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  const shopId = req.shop?.id;
  if (shopId) {
    res.on("finish", () => {
      if (res.statusCode < 400) invalidateShopAvailabilityCaches(shopId);
    });
  }
  next();
});

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

// Time-of-day price/duration windows: an ARRAY of {s,e,price?,durationMin?}
// (same s/e minute bounds as serviceWindowSchema; price/durationMin bounds
// mirror the base fields). Every-day windows layered over the weekday maps -
// "after 9pm this runs $65 and takes 20 min". A window must set at least one
// of price/durationMin (else it does nothing), and windows must not overlap
// (kept in lockstep with the read-side defense in parseTimeWindows).
const timeOverridesSchema = z
  .array(
    z
      .object({
        s: z.number().int().min(0).max(1439),
        e: z.number().int().min(1).max(1440),
        price: z.number().min(0).max(100000).nullable().optional(),
        durationMin: z.number().int().min(5).max(600).nullable().optional(),
      })
      .refine((w) => w.e > w.s, { message: "window end must be after start" })
      .refine(
        (w) =>
          (w.price !== null && w.price !== undefined) ||
          (w.durationMin !== null && w.durationMin !== undefined),
        { message: "window must set a price and/or minutes" },
      ),
  )
  .max(8)
  .refine(
    (windows) => {
      const sorted = [...windows].sort((a, b) => a.s - b.s);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i]!.s < sorted[i - 1]!.e) return false;
      }
      return true;
    },
    { message: "time windows must not overlap" },
  )
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
    timeOverrides: timeOverridesSchema,
    price: z.number().min(0).max(100000).nullable().optional(),
    priceOverrides: priceOverridesSchema,
    // Calendar color: one of the palette keys, or null to clear. Validated
    // against the known keys so a bad value can't land in the column.
    color: z
      .enum(SERVICE_COLOR_KEYS as [string, ...string[]])
      .nullable()
      .optional(),
    // Display-only day-gauge denominator - NOT a cap (see Service.dailyTarget).
    // Only consulted while the service is UNGROUPED; a grouped one is gauged by
    // its group's target.
    dailyTarget: z.number().int().min(1).max(1000).nullable().optional(),
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
      timeOverrides: s.timeOverrides ?? [],
      // Which group (if any) this service belongs to. null for every service on
      // a shop not using groups - the web UI keys the "in group X" badge off it.
      // The bare findMany above returns serviceGroupId by default; ...s carries
      // it, this line just makes the contract explicit.
      serviceGroupId: s.serviceGroupId ?? null,
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
      timeOverrides: d.timeOverrides ?? [],
      color: d.color ?? null,
      price: d.price ?? null,
      priceOverrides: d.priceOverrides ?? {},
      active: d.active ?? true,
      sortOrder: d.sortOrder ?? 0,
      dailyTarget: d.dailyTarget ?? null,
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
  // Existence check DECOUPLED from the update (same fix as /groups/:id below):
  // a staffIds-only PATCH makes the updateMany data empty, and Prisma reports
  // count 0 for an empty update - which the old code misread as "not found",
  // 404ing a legitimate barber reassignment AND skipping the staff re-link.
  const exists = await db.service.findMany({
    where: { id: req.params.id },
    select: { id: true },
  });
  if (exists.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const data = {
    ...(d.name !== undefined ? { name: d.name } : {}),
    ...(d.description !== undefined ? { description: d.description || null } : {}),
    ...(d.imageUrl !== undefined ? { imageUrl: d.imageUrl || null } : {}),
    ...(d.durationMin !== undefined ? { durationMin: d.durationMin } : {}),
    ...(d.durationOverrides !== undefined
      ? { durationOverrides: d.durationOverrides }
      : {}),
    ...(d.hoursWindows !== undefined ? { hoursWindows: d.hoursWindows } : {}),
    ...(d.timeOverrides !== undefined ? { timeOverrides: d.timeOverrides } : {}),
    ...(d.color !== undefined ? { color: d.color } : {}),
    ...(d.price !== undefined ? { price: d.price } : {}),
    ...(d.priceOverrides !== undefined ? { priceOverrides: d.priceOverrides } : {}),
    ...(d.dailyTarget !== undefined
      ? { dailyTarget: d.dailyTarget ?? null }
      : {}),
    ...(d.active !== undefined ? { active: d.active } : {}),
    ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
    ...(d.offeredByAll !== undefined ? { offeredByAll: d.offeredByAll } : {}),
  };
  if (Object.keys(data).length > 0) {
    await db.service.updateMany({ where: { id: req.params.id }, data });
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

//  Service groups (Acuity-style: several services share ONE hours + limits config)

// A group bundles several services under one shared config. It NO LONGER carries
// hours: a group's windows used to override each member service's own, so hours
// were set in one place and shown in another and a grouped service's own windows
// were dead config. Hours live on the Service now (see the 20260804120000
// migration, which copied each active group's windows down onto its members).
// ServiceGroup.hoursWindows remains in the schema, unread, so the change stays
// revertible.
// The two caps are shop-local-day (maxPerDay) and overlapping (maxConcurrent)
// totals across all member services; either null = uncapped. serviceIds is the
// member set to (re)assign on write.
//
// hoursWindows is still ACCEPTED and then IGNORED, deliberately. The schema is
// .strict() like its siblings, so simply deleting the key would 400 any client
// still sending it - and the group editor batches its whole diff into ONE
// payload, so a rename, a cap change and a membership change made in the same
// save would die with it. web and api are separate deploy targets fired by one
// merge with no ordering guarantee, so that skew window is real. Accepting the
// key keeps those saves working; nothing writes it, and the field disappears
// from the UI in the same release.
const groupSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    hoursWindows: hoursWindowsSchema, // accepted for deploy-skew, never written
    maxPerDay: z.number().int().min(1).max(1000).nullable().optional(),
    maxConcurrent: z.number().int().min(1).max(100).nullable().optional(),
    // Display-only day-gauge denominator - NOT a cap (see ServiceGroup.dailyTarget).
    dailyTarget: z.number().int().min(1).max(1000).nullable().optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    serviceIds: z.array(z.string().min(1)).max(200).optional(),
  })
  .strict();

bookingDashboardRouter.get("/groups", async (req, res) => {
  const db = forShop(req.shop!.id);
  const [groups, services] = await Promise.all([
    db.serviceGroup.findMany({
      // DELETE is a soft-delete (active=false, members detached); a deleted
      // group must be GONE from the list, not returned for the UI to filter.
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    // One pass over active services, grouped in JS below - avoids N queries.
    // groupSortOrder first: serviceIds must come back in the group's saved
    // order (it drives the editor's order list AND the public page).
    db.service.findMany({
      where: { active: true },
      select: { id: true, serviceGroupId: true },
      orderBy: [{ groupSortOrder: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    }),
  ]);
  res.json({
    // hoursWindows is destructured OUT, not just left unused: the row spread
    // would otherwise keep shipping a field nothing reads, which is how the
    // dashboard ends up rendering hours that no longer govern anything. The
    // column itself stays populated for revertibility.
    groups: groups.map(({ hoursWindows: _legacyHours, ...g }) => ({
      ...g,
      serviceIds: services
        .filter((s) => s.serviceGroupId === g.id)
        .map((s) => s.id),
    })),
  });
});

bookingDashboardRouter.post("/groups", async (req, res) => {
  const parsed = groupSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const shopId = req.shop!.id;
  // Create the group AND claim its initial members in ONE tx (matching the PATCH
  // reassignment), so a create can never leave a group with zero members because
  // the follow-up assignment failed. Member ids are intersected with this shop's
  // real services (like setServiceStaff's defensive filter) so a foreign/bogus id
  // is silently dropped rather than crossing tenants.
  const groupId = await runWithShop(shopId, async (tx) => {
    const group = await tx.serviceGroup.create({
      data: {
        shopId,
        name: d.name,
        maxPerDay: d.maxPerDay ?? null,
        maxConcurrent: d.maxConcurrent ?? null,
        dailyTarget: d.dailyTarget ?? null,
        active: d.active ?? true,
        sortOrder: d.sortOrder ?? 0,
      },
    });
    if (d.serviceIds && d.serviceIds.length > 0) {
      // active: true — a soft-deleted service must not be claimable (a stale
      // client save could otherwise resurrect it into the group invisibly;
      // GET /groups only lists active members).
      const valid = await tx.service.findMany({
        where: { shopId, active: true, id: { in: d.serviceIds } },
        select: { id: true },
      });
      const validSet = new Set(valid.map((s) => s.id));
      // Claim in the SUBMITTED order — the array's order is the group's
      // display order, stamped onto each member as groupSortOrder.
      const ordered = d.serviceIds.filter((id) => validSet.has(id));
      for (let i = 0; i < ordered.length; i++) {
        await tx.service.update({
          where: { id: ordered[i]! },
          data: { serviceGroupId: group.id, groupSortOrder: i },
        });
      }
    }
    return group.id;
  });
  res.status(201).json({ id: groupId });
});

bookingDashboardRouter.patch("/groups/:id", async (req, res) => {
  const parsed = groupSchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const shopId = req.shop!.id;
  const groupId = req.params.id!;
  const db = forShop(shopId);
  // Existence check DECOUPLED from the update: a membership-only PATCH
  // ({serviceIds} with no scalar fields) makes the updateMany data empty, and
  // Prisma reports count 0 for an empty update - which the old code misread as
  // "not found" and 404'd a legitimate reassignment before ever running it.
  const exists = await db.serviceGroup.findMany({
    where: { id: groupId },
    select: { id: true },
  });
  if (exists.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const data = {
    ...(d.name !== undefined ? { name: d.name } : {}),
    ...(d.maxPerDay !== undefined ? { maxPerDay: d.maxPerDay ?? null } : {}),
    ...(d.maxConcurrent !== undefined
      ? { maxConcurrent: d.maxConcurrent ?? null }
      : {}),
    ...(d.dailyTarget !== undefined
      ? { dailyTarget: d.dailyTarget ?? null }
      : {}),
    ...(d.active !== undefined ? { active: d.active } : {}),
    ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
  };
  if (Object.keys(data).length > 0) {
    await db.serviceGroup.updateMany({ where: { id: groupId }, data });
  }
  // Reassign membership atomically when serviceIds is present: first release any
  // current member no longer listed (-> serviceGroupId null), then claim the
  // listed ones (this shop only). One tx so the group never briefly loses/keeps
  // the wrong members. An empty array clears the group's membership entirely.
  if (d.serviceIds !== undefined) {
    await runWithShop(shopId, async (tx) => {
      const ids = d.serviceIds ?? [];
      // Only ids that are real, ACTIVE services in this shop can be claimed —
      // a soft-deleted id in a stale payload must not rejoin the group.
      const valid =
        ids.length > 0
          ? await tx.service.findMany({
              where: { shopId, active: true, id: { in: ids } },
              select: { id: true },
            })
          : [];
      const validIds = valid.map((s) => s.id);
      // Release ACTIVE members that were in this group but aren't in the new
      // set. A soft-deleted member is deliberately NOT released: it can no
      // longer be claimed (filter above), so without active:true here every
      // membership PATCH would evict it — and slots.ts:215-228 relies on it
      // KEEPING serviceGroupId so its live appointments still consume the
      // group's maxPerDay/maxConcurrent caps. (DELETE /groups below detaches
      // everyone regardless: a deleted group applies no caps at all.)
      await tx.service.updateMany({
        where: {
          shopId,
          active: true,
          serviceGroupId: groupId,
          ...(validIds.length > 0 ? { id: { notIn: validIds } } : {}),
        },
        data: { serviceGroupId: null },
      });
      // Claim the listed (valid) services into this group, in the SUBMITTED
      // order — the array's order is the group's display order, stamped onto
      // each member as groupSortOrder.
      const validSet = new Set(validIds);
      const ordered = ids.filter((id) => validSet.has(id));
      for (let i = 0; i < ordered.length; i++) {
        await tx.service.update({
          where: { id: ordered[i]! },
          data: { serviceGroupId: groupId, groupSortOrder: i },
        });
      }
    });
  }
  res.json({ ok: true });
});

// Soft-delete (active=false) AND detach members in one tx, so a "deleted" group
// can never keep overriding its ex-members' hours/limits. The services survive
// (their serviceGroupId is nulled - onDelete:SetNull semantics, applied here).
bookingDashboardRouter.delete("/groups/:id", async (req, res) => {
  const shopId = req.shop!.id;
  const groupId = req.params.id!;
  const count = await runWithShop(shopId, async (tx) => {
    const updated = await tx.serviceGroup.updateMany({
      where: { shopId, id: groupId },
      data: { active: false },
    });
    if (updated.count > 0) {
      await tx.service.updateMany({
        where: { shopId, serviceGroupId: groupId },
        data: { serviceGroupId: null },
      });
    }
    return updated.count;
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
    // []/omitted = offered on every service; non-empty = only with those
    // services. Ids are intersected with the shop's real services on write
    // (same silent-drop stance as group membership).
    serviceIds: z.array(z.string().min(1)).max(200).optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

/** Keep only ids that are really this shop's services (foreign ids dropped). */
async function validServiceIds(shopId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const real = await forShop(shopId).service.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  const keep = new Set(real.map((s) => s.id));
  return ids.filter((id) => keep.has(id));
}

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
      serviceIds: await validServiceIds(req.shop!.id, d.serviceIds ?? []),
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
  const db = forShop(req.shop!.id);
  // Existence check DECOUPLED from the update (the /groups/:id empty-data
  // gotcha): an empty PATCH body yields empty data, and Prisma's updateMany
  // reports count 0 without touching the DB - not a "not found".
  const exists = await db.serviceAddOn.findMany({
    where: { id: req.params.id },
    select: { id: true },
  });
  if (exists.length === 0) {
    res.status(404).json({ ok: false });
    return;
  }
  const data = {
    ...(d.name !== undefined ? { name: d.name } : {}),
    ...(d.durationMin !== undefined ? { durationMin: d.durationMin } : {}),
    ...(d.price !== undefined ? { price: d.price ?? null } : {}),
    ...(d.serviceIds !== undefined
      ? { serviceIds: await validServiceIds(req.shop!.id, d.serviceIds) }
      : {}),
    ...(d.active !== undefined ? { active: d.active } : {}),
    ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
  };
  if (Object.keys(data).length > 0) {
    await db.serviceAddOn.updateMany({ where: { id: req.params.id }, data });
  }
  res.json({ ok: true });
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
  // Existence check DECOUPLED from the update (the /groups/:id empty-data
  // gotcha): an empty PATCH body yields empty data, and Prisma's updateMany
  // reports count 0 without touching the DB - not a "not found".
  const exists = await db.staff.findMany({
    where: { id: req.params.id },
    select: { id: true },
  });
  if (exists.length === 0) {
    res.json({ ok: false });
    return;
  }
  const data = {
    ...(d.name !== undefined ? { name: d.name } : {}),
    ...(d.bio !== undefined ? { bio: d.bio || null } : {}),
    ...(d.imageUrl !== undefined ? { imageUrl: d.imageUrl || null } : {}),
    ...(d.active !== undefined ? { active: d.active } : {}),
    ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
  };
  if (Object.keys(data).length > 0) {
    await db.staff.updateMany({ where: { id: req.params.id }, data });
  }
  // Reactivating a barber re-joins them to every "offered by all" service (the
  // slot engine ignores inactive staff, so no pruning is needed on deactivation;
  // skipDuplicates makes re-linking an already-linked staff a no-op).
  if (d.active === true) {
    await linkStaffToOfferedByAllServices(req.shop!.id, req.params.id!);
  }
  res.json({ ok: true });
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
  // True only for a synced Acuity/Square booking shown on a NATIVE shop's
  // calendar (a shop mid-transition). Drives the "Acuity/Square" badge that
  // explains why the row can't be acted on — and why its time is blocked.
  // Absent on synced-mode shops, where every row is a visit and a badge on all
  // of them would be noise.
  syncedExternal?: boolean;
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
  // Add-ons frozen onto the booking (native only; [] on visit/block rows).
  // Name-matched to an icon on the dashboard's Today card.
  addOns: { id: string; name: string }[];
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
  // Which AgendaCategory this row counts toward on the day gauge ("Haircuts
  // 10/12") - a ServiceGroup id when the service is grouped, else the Service
  // id. null = uncategorized: a block, or a synced visit whose serviceName
  // matched no service. Uncategorized rows still count in the "All" total.
  categoryId: string | null;
}

/**
 * One bucket of the calendar day gauge. Categories are the barber's own
 * grouping: every active ServiceGroup, plus each active UNGROUPED service (a
 * grouped service is represented by its group, never twice). `target` is the
 * display-only Service/ServiceGroup.dailyTarget - null means the gauge shows a
 * plain count for this bucket instead of a fraction.
 */
interface AgendaCategory {
  id: string;
  name: string;
  target: number | null;
}

/**
 * Fold a service name to a comparison key so a synced Visit (which stores only
 * a name string - Visit has no service relation) can be matched to the shop's
 * own service list. Case/spacing/punctuation and the emoji barbers decorate
 * Acuity names with ("⭐The VIP Package!⭐") are all noise here.
 *
 * Deliberately EXACT-after-folding, never fuzzy: putting a booking in the wrong
 * bucket silently corrupts the number the barber is trying to read, which is
 * worse than leaving it uncategorized.
 */
function serviceNameKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    // Keep letters/digits/spaces; drop emoji, punctuation and combining marks.
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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
// RESCHEDULED -> upcoming: for a synced (Acuity/Square) visit a reschedule
// UPDATES the same row to its new time - ingest upserts on
// @@unique([shopId, acuityAppointmentId]) - so the row IS the live booking.
// There is no separate "old slot" row to hide. The slot engine, status
// promotion and insights all already treat RESCHEDULED as live.
const VISIT_STATUS: Record<string, AgendaStatus> = {
  SCHEDULED: "upcoming",
  COMPLETED: "completed",
  CANCELED: "canceled",
  NO_SHOW: "no_show",
  RESCHEDULED: "upcoming",
};

function fullName(first: string | null, last: string | null): string {
  return `${first ?? ""} ${last ?? ""}`.trim();
}

// forShop() is a hand-curated tenant wrapper that erases nested-relation types
// from a `select`, so we spell out the exact selected shapes and cast to them.
// The cast is safe: it names precisely the fields each `select` below requests.
/**
 * The frozen add-on snapshot on an Appointment is untyped JSON (it may predate
 * the current shape, or be null on older rows), so read it defensively: keep
 * only entries that actually carry an id + name and drop anything else.
 */
function agendaAddOns(raw: Prisma.JsonValue | null): { id: string; name: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { id: string; name: string }[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { id, name } = item as { id?: unknown; name?: unknown };
    if (typeof id === "string" && typeof name === "string") out.push({ id, name });
  }
  return out;
}

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
  service: { id: string; name: string; color: string | null } | null;
  // Frozen AddOnSnapshotItem[] (see engines/addOns.ts) - JSON on the row.
  addOns: Prisma.JsonValue | null;
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
  const { from, staffId } = parsed.data;
  // The web asks for a month plus padding (~59 days). Bound the window so the
  // generous row caps below can't be turned into a full-table read by a
  // hand-crafted range.
  const MAX_AGENDA_MS = 93 * 24 * 60 * 60 * 1000;
  const to =
    parsed.data.to.getTime() - from.getTime() > MAX_AGENDA_MS
      ? new Date(from.getTime() + MAX_AGENDA_MS)
      : parsed.data.to;

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

  const shopId = req.shop!.id;
  // ONE shop-scoped transaction for the whole request. The agenda used to make
  // up to nine forShop calls, and every forShop call is its own transaction -
  // BEGIN + SET ROLE + set_config + query + COMMIT, each a real DB round trip.
  // On the phone (device -> Vercel -> Railway -> Supabase) that stacked into
  // "the calendar is slow". Same reads, same RLS guarantees, one transaction.
  const { agenda, categories } = await runWithShop(shopId, async (tx) => {

  // ---- Day-gauge categories (both booking modes) ----
  // A grouped service is represented ONLY by its group, so a booking is never
  // counted in two buckets and the per-bucket totals sum to the "All" total -
  // which is the whole point of the gauge (10/12 + 2/4 = 12/16).
  const [groupRows, serviceRows] = await tx.serviceGroup
    .findMany({
      where: { shopId, active: true },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, dailyTarget: true },
    })
    .then(async (groups) => [
      groups,
      // NOT filtered to active: a booking on a since-retired service must still
      // land in its group's bucket, or past days would silently under-count.
      // The category LIST below is filtered instead, so a retired service never
      // grows a chip of its own.
      await tx.service.findMany({
        where: { shopId },
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          name: true,
          dailyTarget: true,
          serviceGroupId: true,
          active: true,
        },
      }),
    ] as const);
  const categories: AgendaCategory[] = [
    ...groupRows.map((g) => ({ id: g.id, name: g.name, target: g.dailyTarget })),
    ...serviceRows
      .filter((s) => s.active && s.serviceGroupId === null)
      .map((s) => ({ id: s.id, name: s.name, target: s.dailyTarget })),
  ];
  /** Service id -> the category it counts toward (its group, else itself). */
  const categoryOfService = new Map<string, string>(
    serviceRows.map((s) => [s.id, s.serviceGroupId ?? s.id]),
  );
  // Folded service name -> category, for synced Visits. A name that folds to the
  // same key on two DIFFERENT categories is ambiguous, so it maps to nothing
  // rather than guessing (see serviceNameKey).
  const categoryOfName = new Map<string, string | null>();
  for (const s of serviceRows.filter((s) => s.active)) {
    const key = serviceNameKey(s.name);
    if (!key) continue;
    const category = s.serviceGroupId ?? s.id;
    const seen = categoryOfName.get(key);
    categoryOfName.set(
      key,
      seen === undefined || seen === category ? category : null,
    );
  }

  // Acuity blocked-off time, on BOTH calendars: a synced shop's barber blocks
  // his lunch in Acuity and the ChairBack calendar showed an unexplained gap;
  // a native shop mid-transition had those hours silently offered. Read-only
  // here - Acuity owns them (see ExternalBlock).
  const externalBlockRows = await tx.externalBlock.findMany({
    where: { shopId, startsAt: { lte: to }, endsAt: { gte: from } },
    orderBy: { startsAt: "asc" },
    take: 1000,
    select: { id: true, startsAt: true, endsAt: true, reason: true },
  });
  const externalBlockAgenda: AgendaRow[] = externalBlockRows.map((b) => ({
    id: b.id,
    source: "block" as const,
    syncedExternal: true,
    start: b.startsAt.toISOString(),
    end: b.endsAt.toISOString(),
    clientName: b.reason || "Blocked in Acuity",
    serviceName: null,
    serviceColor: null,
    price: null,
    status: "blocked" as const,
    seriesId: null,
    checkInStatus: null,
    etaMinutes: null,
    runningLate: false,
    addOns: [],
    hasPush: false,
    nudgesSent: 0,
    nudgeLimit: APPOINTMENT_NUDGE_LIMIT,
    clientId: null,
    rewardReady: null,
    categoryId: null, // blocked time isn't a booking - never gauged
  }));

  let agenda: AgendaRow[];

  if (shop.bookingMode === "native") {
    const rows = (await tx.appointment.findMany({
      where: {
        shopId,
        startsAt: { gte: from, lte: to },
        ...(staffId ? { staffId } : {}),
        // Keep AI-receptionist holds off the calendar (see the list above).
        holdExpiresAt: null,
      },
      orderBy: { startsAt: "asc" },
      // High enough that a busy multi-chair shop's full month (the web asks
      // for ~59 days) can never truncate: ascending order + a tight cap used
      // to silently eat the BACK of the window - later days rendered empty
      // and read as "sync stops partway through the month".
      take: 2000,
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
        service: { select: { id: true, name: true, color: true } },
        addOns: true,
      },
    })) as unknown as ApptAgendaRow[];

    // Nudge affordances, batched: which clients have a push device at all, and
    // how many nudges each appointment already used (max 2, server-enforced).
    const clientIds = [...new Set(rows.map((r) => r.clientId).filter(Boolean))] as string[];
    const pushClients = new Set(
      clientIds.length === 0
        ? []
        : (
            await tx.pushSubscription.findMany({
              where: { shopId, clientId: { in: clientIds } },
              select: { clientId: true },
            })
          ).map((s) => s.clientId),
    );
    const apptIds = rows.map((r) => r.id);
    const nudgeCounts = new Map<string, number>();
    if (apptIds.length > 0) {
      const nudgeRows = await tx.nudge.findMany({
        // Mirror the engine's cap predicate: FAILED (undelivered) attempts
        // don't consume a nudge, so they mustn't show as used here either.
        where: {
          shopId,
          appointmentId: { in: apptIds },
          kind: APPOINTMENT_NUDGE_KIND,
          status: { in: ["PENDING", "SENT"] },
        },
        select: { appointmentId: true },
      });
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
      const rewardRows = await tx.reward.findMany({
        where: { shopId, active: true },
        orderBy: { punchCost: "asc" },
        select: { id: true, name: true, punchCost: true, cardTypeId: true },
      });
      if (rewardRows.length > 0) {
        const groups = await tx.punchLedger.groupBy({
          by: ["clientId", "cardTypeId"],
          where: { shopId, clientId: { in: clientIds } },
          _sum: { punchesEarned: true, punchesRedeemed: true },
        });
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
      addOns: agendaAddOns(a.addOns),
      hasPush: a.clientId !== null && pushClients.has(a.clientId),
      nudgesSent: nudgeCounts.get(a.id) ?? 0,
      nudgeLimit: APPOINTMENT_NUDGE_LIMIT,
      clientId: a.clientId,
      rewardReady:
        a.clientId !== null
          ? (rewardReadyByClient.get(a.clientId) ?? null)
          : null,
      categoryId: (a.service && categoryOfService.get(a.service.id)) ?? null,
    }));

    // Blocked time (barber "Block Off Time") shows on the calendar too, as
    // distinct rows so the day view reflects when the chair is unavailable.
    const blocks = await tx.availabilityException.findMany({
      where: {
        shopId,
        isBlock: true,
        startsAt: { gte: from, lte: to },
        ...(staffId ? { staffId } : {}),
      },
      orderBy: { startsAt: "asc" },
      take: 1000,
      select: { id: true, startsAt: true, endsAt: true, reason: true },
    });
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
        addOns: [],
        hasPush: false,
        nudgesSent: 0,
        nudgeLimit: APPOINTMENT_NUDGE_LIMIT,
        clientId: null,
        rewardReady: null,
        categoryId: null, // blocked time isn't a booking - never gauged
      });
    }

    // EXTERNAL synced appointments (Acuity / Square) on a NATIVE shop's
    // calendar. A shop mid-transition still takes bookings in Acuity, and
    // since the visit-busy fix those Visits BLOCK native slots shop-wide — but
    // they were never rendered here, so the barber saw a half-empty ChairBack
    // calendar and unexplained dead slots ("it's not syncing my Acuity").
    // Showing them makes the calendar the whole truth about the chair and
    // explains every blocked slot.
    //
    // `appointment: null` = purely external: a Visit promoted FROM a native
    // appointment is already on this calendar as its Appointment row, and
    // would otherwise render twice. Same predicate the busy-set uses, so what
    // blocks a slot and what shows here can't drift apart.
    //
    // NOT filtered by staffId even when the barber filters the calendar: a
    // Visit carries no staff, and the engine blocks EVERY staffer's slots for
    // its window — hiding it under a filter would recreate the same mystery
    // one level down.
    const externalVisits = (await tx.visit.findMany({
      where: {
        shopId,
        scheduledAt: { gte: from, lte: to },
        appointment: null,
        // A cancelled booking is not on the schedule. Acuity tells us via the
        // appointment.canceled webhook (or the resync sweep) and the row flips
        // to CANCELED; it used to keep rendering, just dimmed, so a client who
        // cancelled still looked like they were coming in. RESCHEDULED stays:
        // a reschedule UPDATES this same row to its new time (see
        // VISIT_STATUS), so filtering it would erase a live booking.
        status: { not: "CANCELED" },
      },
      orderBy: { scheduledAt: "asc" },
      take: 2000,
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
    for (const v of externalVisits) {
      agenda.push({
        id: v.id,
        source: "visit",
        // Read-only in the UI (row actions are gated on source==="appointment"):
        // the booking platform owns these, so ChairBack must never pretend to
        // cancel or complete one.
        syncedExternal: true,
        start: v.scheduledAt.toISOString(),
        end: v.endAt ? v.endAt.toISOString() : null,
        clientName:
          fullName(v.client?.firstName ?? null, v.client?.lastName ?? null) ||
          "Booked elsewhere",
        serviceName: v.serviceName ?? null,
        serviceColor: null,
        price: v.price == null ? null : Number(v.price),
        status: VISIT_STATUS[v.status] ?? "upcoming",
        seriesId: null,
        checkInStatus: null,
        etaMinutes: null,
        runningLate: false,
        addOns: [],
        hasPush: false,
        nudgesSent: 0,
        nudgeLimit: APPOINTMENT_NUDGE_LIMIT,
        clientId: null,
        rewardReady: null,
        // Name-matched like any synced visit (#153 puts these on a NATIVE
        // shop's calendar too). Without this a shop mid-transition would see
        // its Acuity bookings land outside every bucket, so "Haircuts 10/12"
        // would undercount exactly the days it's busiest.
        categoryId: v.serviceName
          ? (categoryOfName.get(serviceNameKey(v.serviceName)) ?? null)
          : null,
      });
    }

    agenda.push(...externalBlockAgenda);
    agenda.sort((a, b) => a.start.localeCompare(b.start));
  } else {
    // Synced shops (Acuity / Square / link): appointments are Visit rows. There's
    // no staff relation on Visit, so a staffId filter simply doesn't apply.
    const rows = (await tx.visit.findMany({
      where: {
        shopId,
        scheduledAt: { gte: from, lte: to },
        // Same rule as the native branch above: cancelled bookings are off the
        // schedule; RESCHEDULED rows are live at their new time and stay.
        status: { not: "CANCELED" },
      },
      orderBy: { scheduledAt: "asc" },
      take: 2000,
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
      addOns: [], // synced Visits carry no ChairBack add-on snapshot
      hasPush: false,
      nudgesSent: 0,
      nudgeLimit: APPOINTMENT_NUDGE_LIMIT,
      clientId: null,
      rewardReady: null,
      // Visit carries only a name string, so the bucket is name-matched. No
      // match (or an ambiguous one) = uncategorized, counted in "All" only.
      categoryId: v.serviceName
        ? (categoryOfName.get(serviceNameKey(v.serviceName)) ?? null)
        : null,
    }));
    agenda.push(...externalBlockAgenda);
    agenda.sort((a, b) => a.start.localeCompare(b.start));
  }

  return { agenda, categories };
  }); // end of the one shop-scoped transaction

  res.json({
    agenda,
    source: shop.bookingMode === "native" ? "appointment" : "visit",
    timezone: shop.timezone,
    categories,
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
      timeOverrides: true,
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
  // Effective duration for the picked slot - weekday layer plus time-of-day
  // windows (mirrors the effectivePriceAt snapshot just below).
  const effectiveDuration = effectiveDurationAt(service.durationMin, {
    at: startsAt,
    timezone: shop.timezone,
    weekdayOverrides: service.durationOverrides,
    timeWindows: service.timeOverrides,
  });
  const endsAt = new Date(
    startsAt.getTime() + (effectiveDuration + addOns.extraDurationMin) * 60_000,
  );
  const basePrice = effectivePriceAt(
    service.price === null ? null : Number(service.price),
    {
      at: startsAt,
      timezone: shop.timezone,
      weekdayOverrides: service.priceOverrides,
      timeWindows: service.timeOverrides,
    },
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
        timeOverrides: service.timeOverrides,
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
        shopId: shop.id,
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
    // "Until I turn it off": an INDEFINITE weekly series. Creates a
    // TargetedSlotRule; the roll-forward job keeps materializing rows to the
    // horizon until the rule is turned off. Mutually exclusive with repeatWeeks.
    repeatForever: z.boolean().optional(),
  })
  .strict()
  .refine((d) => !(d.repeatForever && (d.repeatWeeks ?? 0) > 0), {
    message: "repeatWeeks and repeatForever are mutually exclusive",
    path: ["repeatWeeks"],
  });

// The schedule-shaped create: any set of weekdays x times per week ("every
// night at 9pm", "mornings AND afternoons daily"), one rule. Times are
// wall-clock "HH:MM" in the shop's timezone; per-time duration/price override
// the rule's base when a morning special runs shorter or cheaper than the
// evening one.
const scheduleTimeSchema = z
  .object({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    durationMin: z.number().int().min(5).max(600).optional(),
    price: z.number().min(0).max(100000).optional(),
  })
  .strict();
const targetedScheduleSchema = z
  .object({
    staffId: z.string().min(1),
    serviceId: z.string().min(1),
    label: z.string().trim().max(60).optional().or(z.literal("")),
    durationMin: z.number().int().min(5).max(600),
    price: z.number().min(0).max(100000),
    // {"0".."6": [{start, ...}]} - hoursWindows key convention (0=Sun).
    schedule: z
      .record(z.string().regex(/^[0-6]$/), z.array(scheduleTimeSchema).min(1).max(8))
      .refine((m) => Object.keys(m).length >= 1, { message: "pick at least one day" }),
    // First day the series may run (shop-local). Defaults to today.
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    repeatWeeks: z.number().int().min(0).max(26).optional(),
    repeatForever: z.boolean().optional(),
  })
  .strict()
  .refine((d) => !(d.repeatForever && (d.repeatWeeks ?? 0) > 0), {
    message: "repeatWeeks and repeatForever are mutually exclusive",
    path: ["repeatWeeks"],
  });

bookingDashboardRouter.get("/targeted-slots", async (req, res) => {
  const tsShopId = req.shop!.id;
  const shop = await prisma.shop.findUnique({
    where: { id: tsShopId },
    select: { timezone: true },
  });
  // One transaction for both reads (each forShop call is its own tx).
  const { slots, rules } = await runWithShop(tsShopId, async (tx) => ({
    slots: await tx.targetedSlot.findMany({
      where: { shopId: tsShopId, startsAt: { gt: new Date() } },
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
        ruleId: true,
        bookedAppointmentId: true,
      },
    }),
    // Active rules drive the condensed series cards (and the finite ones give
    // a batch its group header + "Remove series").
    rules: await tx.targetedSlotRule.findMany({
      where: { shopId: tsShopId, active: true },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        staffId: true,
        serviceId: true,
        label: true,
        anchor: true,
        durationMin: true,
        price: true,
        schedule: true,
        indefinite: true,
      },
    }),
  }));
  const tz = shop?.timezone ?? "America/New_York";
  res.json({
    targetedSlots: slots.map((t) => ({
      ...t,
      startsAt: t.startsAt.toISOString(),
      price: Number(t.price),
      booked: t.bookedAppointmentId !== null,
    })),
    rules: rules.map((r) => {
      // Display-ready cadence, computed server-side (the server knows the shop
      // timezone; the dashboard shouldn't re-derive weekday math). A legacy
      // rule (schedule {}) comes back as the derived single-day map, so the
      // dashboard renders exactly one shape.
      return {
        id: r.id,
        staffId: r.staffId,
        serviceId: r.serviceId,
        label: r.label,
        schedule: effectiveSchedule(
          { anchor: r.anchor, schedule: r.schedule },
          tz,
        ),
        durationMin: r.durationMin,
        price: Number(r.price),
        indefinite: r.indefinite,
      };
    }),
  });
});

bookingDashboardRouter.post("/targeted-slots", async (req, res) => {
  // The schedule-shaped create: weekdays x times, one rule. Detected by the
  // `schedule` key so the one-off/legacy shape below keeps working untouched.
  if (req.body && typeof req.body === "object" && "schedule" in req.body) {
    const parsedSched = targetedScheduleSchema.safeParse(req.body);
    if (!parsedSched.success) {
      res
        .status(400)
        .json({ error: "invalid_input", issues: parsedSched.error.issues });
      return;
    }
    const s = parsedSched.data;
    const shopId = req.shop!.id;
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { timezone: true, bookingMode: true },
    });
    if (!shop || shop.bookingMode !== "native") {
      res.status(400).json({ error: "not_native" });
      return;
    }
    const db = forShop(shopId);
    const [service, staff] = await Promise.all([
      db.service.findFirst({ where: { id: s.serviceId, active: true }, select: { id: true } }),
      db.staff.findFirst({ where: { id: s.staffId, active: true }, select: { id: true } }),
    ]);
    if (!service || !staff) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }

    const tz = shop.timezone;
    const now = new Date();
    // "HH:MM" -> shop-local minutes, the storage shape.
    const schedule: RuleSchedule = {};
    for (const [wd, times] of Object.entries(s.schedule)) {
      schedule[wd] = times
        .map((t) => ({
          startMin:
            Number(t.start.slice(0, 2)) * 60 + Number(t.start.slice(3, 5)),
          ...(t.durationMin !== undefined ? { durationMin: t.durationMin } : {}),
          ...(t.price !== undefined ? { price: t.price } : {}),
        }))
        .sort((a, b) => a.startMin - b.startMin);
    }

    // The series starts at its FIRST future occurrence on/after startDate
    // (default today). Scan 8 days so a single-weekday schedule whose times
    // already passed today lands on next week's occurrence.
    const todayParts = zonedDateParts(now, tz);
    let base = { year: todayParts.year, month0: todayParts.month0, day: todayParts.day };
    if (s.startDate) {
      const [y, m, day] = s.startDate.split("-").map(Number);
      const requested = { year: y!, month0: m! - 1, day: day! };
      // A past startDate means "already running" - series start from today.
      if (zonedWallTimeToUtc(requested.year, requested.month0, requested.day + 1, 0, tz) > now) {
        base = requested;
      }
    }
    const baseWeekday = zonedDateParts(
      zonedWallTimeToUtc(base.year, base.month0, base.day, 12 * 60, tz),
      tz,
    ).weekday;
    let anchor: Date | null = null;
    outer: for (let d = 0; d <= 7; d++) {
      const times = schedule[String((baseWeekday + d) % 7)];
      if (!times) continue;
      for (const t of times) {
        const instant = zonedWallTimeToUtc(base.year, base.month0, base.day + d, t.startMin, tz);
        if (instant.getTime() > now.getTime()) {
          anchor = instant;
          break outer;
        }
      }
    }
    if (!anchor) {
      res.status(400).json({ error: "in_the_past" });
      return;
    }

    const rule = await db.targetedSlotRule.create({
      data: {
        staffId: s.staffId,
        serviceId: s.serviceId,
        label: s.label?.trim() || null,
        anchor,
        durationMin: s.durationMin,
        price: s.price,
        schedule: schedule as never,
        indefinite: Boolean(s.repeatForever),
      },
    });
    // Indefinite: the standard rolling horizon (the daily job extends it).
    // Finite: exactly repeat+1 weeks, all up front - the horizon lands at the
    // shop-local midnight after the last week (minus 1ms so a midnight time
    // in week repeat+1 can't sneak in).
    const anchorParts = zonedDateParts(anchor, tz);
    const horizonEnd = s.repeatForever
      ? new Date(Date.now() + TARGETED_RULE_HORIZON_DAYS * 24 * 60 * 60 * 1000)
      : new Date(
          zonedWallTimeToUtc(
            anchorParts.year,
            anchorParts.month0,
            anchorParts.day + ((s.repeatWeeks ?? 0) + 1) * 7,
            0,
            tz,
          ).getTime() - 1,
        );
    const created = await materializeTargetedRule(
      { ...rule, shopId },
      tz,
      horizonEnd,
    );
    res.status(201).json({ ok: true, created, ruleId: rule.id });
    return;
  }

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

  const label = d.label?.trim() || null;

  // "Until I turn it off": store a rule and let the shared materializer create
  // the first horizon of rows; the roll-forward job keeps extending it.
  if (d.repeatForever) {
    const rule = await db.targetedSlotRule.create({
      data: {
        staffId: d.staffId,
        serviceId: d.serviceId,
        label,
        anchor: d.startsAt,
        durationMin: d.durationMin,
        price: d.price,
        indefinite: true,
      },
    });
    const created = await materializeTargetedRule(
      { ...rule, shopId: req.shop!.id },
      shop.timezone,
      new Date(Date.now() + TARGETED_RULE_HORIZON_DAYS * 24 * 60 * 60 * 1000),
    );
    res.status(201).json({ ok: true, created, ruleId: rule.id });
    return;
  }

  // Materialize the weekly repeats at the SAME shop-local wall time (a naive
  // +7d of the UTC instant would drift an hour across a DST change). A finite
  // batch (repeatWeeks > 0) also gets a rule row — not for roll-forward
  // (indefinite=false), but so the dashboard can render the batch as ONE
  // condensed series and delete it in one tap.
  const repeat = d.repeatWeeks ?? 0;
  const rule =
    repeat > 0
      ? await db.targetedSlotRule.create({
          data: {
            staffId: d.staffId,
            serviceId: d.serviceId,
            label,
            anchor: d.startsAt,
            durationMin: d.durationMin,
            price: d.price,
            indefinite: false,
            weeksMaterialized: repeat + 1,
          },
        })
      : null;
  const anchor = zonedDateParts(d.startsAt, shop.timezone);
  const wallMin = localMinutesOfDay(d.startsAt, shop.timezone);
  const rows = [];
  for (let week = 0; week <= repeat; week++) {
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
      label,
      startsAt,
      durationMin: d.durationMin,
      price: d.price,
      ruleId: rule?.id ?? null,
    });
  }
  await db.targetedSlot.createMany({ data: rows });
  res.status(201).json({ ok: true, created: rows.length, ruleId: rule?.id ?? null });
});

// Turn a series off (indefinite) / remove a finite batch: deactivate the rule
// and delete its FUTURE UNBOOKED rows in one tx. Booked and past rows survive
// as history — same stance as the single-row delete's 409.
bookingDashboardRouter.delete("/targeted-slots/rules/:id", async (req, res) => {
  const shopId = req.shop!.id;
  const ruleId = req.params.id!;
  const result = await runWithShop(shopId, async (tx) => {
    const off = await tx.targetedSlotRule.updateMany({
      where: { shopId, id: ruleId },
      data: { active: false },
    });
    if (off.count === 0) return null;
    const removed = await tx.targetedSlot.deleteMany({
      where: {
        shopId,
        ruleId,
        bookedAppointmentId: null,
        startsAt: { gt: new Date() },
      },
    });
    return removed.count;
  });
  if (result === null) {
    res.status(404).json({ ok: false });
    return;
  }
  res.json({ ok: true, removed: result });
});

// Bulk remove hand-picked UNBOOKED slots ("select to delete"). Booked ids in
// the list are simply not removed (the response count says how many were).
const bulkDeleteSchema = z
  .object({ ids: z.array(z.string().min(1)).min(1).max(200) })
  .strict();
bookingDashboardRouter.post("/targeted-slots/bulk-delete", async (req, res) => {
  const parsed = bulkDeleteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const { count } = await forShop(req.shop!.id).targetedSlot.deleteMany({
    where: { id: { in: parsed.data.ids }, bookedAppointmentId: null },
  });
  res.json({ ok: true, removed: count });
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
        shopId,
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
