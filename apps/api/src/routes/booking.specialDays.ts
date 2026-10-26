import type { Router } from "express";
import { z } from "zod";
import { asOwnerWithin, forShop, prisma, runWithShop } from "@chairback/db";
import { zonedDateKey } from "@chairback/config";
import {
  MAX_HOLIDAY_NAME,
  parseDateOverrides,
  parseHolidayNames,
} from "@chairback/config/servicePricing";
import {
  listSpecialDays,
  MAX_SPECIAL_DAY_CHAIRS,
  MAX_SPECIAL_DAY_OPENINGS,
  openingStartMinutes,
  planSpecialDay,
  publishSpecialDay,
  removeSpecialDays,
  type ChairPlan,
  type SpecialDaySpec,
} from "../engines/specialDay.js";
import { loadDayView, saveDay } from "../engines/specialDayView.js";
import { OPENING_CONFLICT_WORDS } from "@chairback/config/specialDay";

/**
 * Holidays (named, edited in one save) and Special days (engines/specialDay.ts).
 * Mounted on the dashboard router, so requireManager (owner/manager only),
 * active access and the availability-cache hook cover every route here.
 */

/** A real calendar date, YYYY-MM-DD. */
const DAY_KEY = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((k) => k in parseDateOverrides({ [k]: 0 }), "Not a real date");
/** Same per-service cap as the service PATCH (dateOverridesSchema). */
const MAX_DATES_PER_SERVICE = 120;

const holidaySchema = z
  .object({
    // The dates this save takes OFF every service (an edit's old dates, or a
    // removal). Applied first, so an edit that keeps a date simply re-prices it.
    removeDates: z.array(DAY_KEY).max(MAX_DATES_PER_SERVICE).default([]),
    // The dates priced by this save, on exactly `serviceIds`, at `price`.
    dates: z.array(DAY_KEY).max(MAX_DATES_PER_SERVICE).default([]),
    price: z.number().min(0).max(100000).optional(),
    serviceIds: z.array(z.string().min(1)).max(200).default([]),
    name: z.string().trim().max(MAX_HOLIDAY_NAME).optional().or(z.literal("")),
  })
  .strict()
  .refine((d) => d.dates.length === 0 || (d.price !== undefined && d.serviceIds.length > 0), {
    message: "Pricing a date needs a price and at least one service",
    path: ["dates"],
  })
  .refine((d) => d.dates.length > 0 || d.removeDates.length > 0, { message: "nothing to change" });

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

const specialDaySchema = z
  .object({
    date: DAY_KEY,
    staffIds: z.array(z.string().min(1)).min(1).max(MAX_SPECIAL_DAY_CHAIRS),
    start: HHMM,
    end: HHMM,
    cutMin: z.number().int().min(5).max(240),
    price: z.number().min(0).max(100000),
    serviceIds: z.array(z.string().min(1)).min(1).max(50),
    name: z.string().trim().max(MAX_HOLIDAY_NAME).optional().or(z.literal("")),
    // Minted once per form; a retried publish replays instead of doubling.
    requestId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional(),
    // How many openings the preview showed. Publish refuses if that changed.
    expectOpenings: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .refine((d) => toMin(d.end) > toMin(d.start), { message: "End after start", path: ["end"] });

type SpecialDayBody = z.infer<typeof specialDaySchema>;

/** The plan as JSON, with each chair's openings as ISO instants. */
function plansJson(plans: ChairPlan[]) {
  return plans.map((p) => ({
    staffId: p.staffId,
    openings: p.openings.map((o) => o.startsAt.toISOString()),
    skipped: p.skipped.map((s) => ({ startsAt: s.startsAt.toISOString(), reason: s.reason })),
    bookings: p.bookings.map((b) => ({ startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString() })),
  }));
}

/**
 * Everything a special-day request must pass before anything is planned: a
 * native shop, a date not already behind it, this shop's ACTIVE chairs and
 * services (the ids come off the request body), and a window that holds at
 * least one opening and not more than the cap.
 */
async function checkSpecialDay(
  shopId: string,
  d: SpecialDayBody,
): Promise<
  | { ok: true; timezone: string; bufferMin: number; spec: SpecialDaySpec; serviceIds: string[] }
  | { ok: false; status: number; error: string; message: string }
> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { timezone: true, bookingMode: true, bookingBufferMin: true },
  });
  if (!shop || shop.bookingMode !== "native") {
    return { ok: false, status: 400, error: "not_native", message: "Special days need ChairBack booking turned on." };
  }
  if (d.date < zonedDateKey(new Date(), shop.timezone)) {
    return { ok: false, status: 400, error: "in_the_past", message: "That date has already passed." };
  }
  const staffIds = [...new Set(d.staffIds)];
  const serviceIds = [...new Set(d.serviceIds)];
  const db = forShop(shopId);
  const [staff, services] = await Promise.all([
    db.staff.findMany({ where: { id: { in: staffIds }, active: true }, select: { id: true } }),
    db.service.findMany({ where: { id: { in: serviceIds }, active: true }, select: { id: true } }),
  ]);
  if (staff.length !== staffIds.length || services.length !== serviceIds.length) {
    return { ok: false, status: 400, error: "invalid_input", message: "Pick chairs and services from this shop." };
  }
  const spec: SpecialDaySpec = {
    date: d.date,
    staffIds,
    startMin: toMin(d.start),
    endMin: toMin(d.end),
    cutMin: d.cutMin,
  };
  const count = openingStartMinutes({ ...spec, bufferMin: shop.bookingBufferMin }).length;
  if (count === 0) {
    return { ok: false, status: 400, error: "window_too_short", message: "Not even one opening fits between those times." };
  }
  if (count > MAX_SPECIAL_DAY_OPENINGS) {
    return {
      ok: false,
      status: 400,
      error: "too_many_openings",
      message: `That is ${count} openings per chair. The most is ${MAX_SPECIAL_DAY_OPENINGS} - use a longer cut or a shorter day.`,
    };
  }
  return { ok: true, timezone: shop.timezone, bufferMin: shop.bookingBufferMin, spec, serviceIds };
}

/**
 * The shop facts the live view needs, or why the date cannot be opened: a
 * native shop, a real date not already behind it. The chairs are the shop's
 * ACTIVE staff - every one of them is drawn, so the basis covers them all.
 */
async function liveViewShop(
  shopId: string,
  date: string,
): Promise<
  | { ok: true; timezone: string; bufferMin: number; staffIds: string[] }
  | { ok: false; status: number; error: string; message: string }
> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { timezone: true, bookingMode: true, bookingBufferMin: true },
  });
  if (!shop || shop.bookingMode !== "native") {
    return { ok: false, status: 400, error: "not_native", message: "Special days need ChairBack booking turned on." };
  }
  if (date < zonedDateKey(new Date(), shop.timezone)) {
    return { ok: false, status: 400, error: "in_the_past", message: "That date has already passed." };
  }
  const staff = await forShop(shopId).staff.findMany({
    where: { active: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (staff.length === 0) {
    return { ok: false, status: 400, error: "no_staff", message: "Add someone to the team first." };
  }
  if (staff.length > MAX_SPECIAL_DAY_CHAIRS * 4) {
    return { ok: false, status: 400, error: "too_many_chairs", message: "Too many people to show on one day." };
  }
  return { ok: true, timezone: shop.timezone, bufferMin: shop.bookingBufferMin, staffIds: staff.map((s) => s.id) };
}

const liveOpening = z
  .object({
    id: z.string().min(1).max(64).optional(),
    startMin: z.number().int().min(0).max(1439),
    durationMin: z.number().int().min(5).max(240),
    price: z.number().min(0).max(100000),
  })
  .strict();

const liveSaveSchema = z
  .object({
    date: DAY_KEY,
    name: z.string().trim().max(MAX_HOLIDAY_NAME).optional().or(z.literal("")),
    serviceIds: z.array(z.string().min(1)).max(50).default([]),
    chairs: z
      .array(
        z
          .object({
            staffId: z.string().min(1),
            openings: z.array(liveOpening).max(MAX_SPECIAL_DAY_OPENINGS),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_SPECIAL_DAY_CHAIRS * 4),
    // The view's fingerprint: the save is refused (409) if the day changed.
    basis: z.string().min(8).max(128),
    // Minted once per save; a retried save replays instead of writing twice.
    requestId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional(),
    // The barber chose to open special times over his OWN block-off that day
    // (engines/specialDayView.ts saveDay `overOwnBlocks`).
    overOwnBlocks: z.boolean().optional(),
  })
  .strict()
  .refine((d) => d.serviceIds.length > 0 || d.chairs.every((c) => c.openings.length === 0), {
    message: "Choose which services the openings count as",
    path: ["serviceIds"],
  });

const REFUSAL_WORDS: Record<string, string> = {
  ...OPENING_CONFLICT_WORDS,
  unknown_opening: "that opening is no longer on the day",
  booked_opening: "a booked opening can't be changed",
  too_many_openings: `one day holds at most ${MAX_SPECIAL_DAY_OPENINGS} openings per person`,
};

export function registerSpecialDayRoutes(router: Router): void {
  /**
   * PUT /holidays - add, edit or remove a holiday in ONE transaction.
   *
   * The Holiday pricing card used to send one PATCH per service, so an edit
   * that failed half way could leave some services on the old date and some
   * on the new. Here every service's dateOverrides and the shop's name for
   * the date are rewritten together, or not at all.
   */
  router.put("/holidays", async (req, res) => {
    const parsed = holidaySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const shopId = req.shop!.id;
    const picked = new Set(d.serviceIds);
    type Outcome = { ok: true; services: number } | { ok: false; error: string; status: number };
    const outcome: Outcome = await runWithShop(shopId, async (tx) => {
      const services = await tx.service.findMany({
        where: { shopId },
        select: { id: true, active: true, dateOverrides: true },
      });
      const known = new Map(services.map((s) => [s.id, s]));
      for (const id of picked) {
        if (!known.get(id)?.active) return { ok: false, error: "invalid_service", status: 400 };
      }
      let changed = 0;
      for (const s of services) {
        const before = parseDateOverrides(s.dateOverrides);
        const next = { ...before };
        for (const k of d.removeDates) delete next[k];
        if (picked.has(s.id)) for (const k of d.dates) next[k] = d.price!;
        if (JSON.stringify(next) === JSON.stringify(before)) continue;
        if (Object.keys(next).length > MAX_DATES_PER_SERVICE) {
          return { ok: false, error: "too_many_dates", status: 400 };
        }
        await tx.service.update({ where: { id: s.id }, data: { dateOverrides: next } });
        changed++;
      }
      // Shop is a platform table (default-deny to the tenant role), and the
      // name must land in the SAME transaction as the prices - so this one
      // read-modify-write of the caller's own shop row runs as the owner.
      await asOwnerWithin(tx, async (otx) => {
        const shop = await otx.shop.findUnique({ where: { id: shopId }, select: { holidayNames: true } });
        const names = parseHolidayNames(shop?.holidayNames);
        for (const k of d.removeDates) delete names[k];
        const name = d.name?.trim() ?? "";
        for (const k of d.dates) {
          if (name) names[k] = name;
          else delete names[k];
        }
        await otx.shop.update({ where: { id: shopId }, data: { holidayNames: names } });
      });
      return { ok: true, services: changed };
    });
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }
    res.json(outcome);
  });

  /** GET /special-days - the special days still ahead, per chair. */
  router.get("/special-days", async (req, res) => {
    const shopId = req.shop!.id;
    const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { timezone: true } });
    res.json({ specialDays: await listSpecialDays(shopId, shop?.timezone ?? "America/New_York", new Date()) });
  });

  /** POST /special-days/preview - what publishing would create. Writes nothing. */
  router.post("/special-days/preview", async (req, res) => {
    const parsed = specialDaySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
      return;
    }
    const checked = await checkSpecialDay(req.shop!.id, parsed.data);
    if (!checked.ok) {
      res.status(checked.status).json({ error: checked.error, message: checked.message });
      return;
    }
    const plans = await planSpecialDay(prisma, {
      shopId: req.shop!.id,
      timezone: checked.timezone,
      bufferMin: checked.bufferMin,
      spec: checked.spec,
      now: new Date(),
    });
    res.json({ bufferMin: checked.bufferMin, timezone: checked.timezone, plans: plansJson(plans) });
  });

  /** POST /special-days - publish (all chairs, one transaction). */
  router.post("/special-days", async (req, res) => {
    const parsed = specialDaySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const checked = await checkSpecialDay(req.shop!.id, d);
    if (!checked.ok) {
      res.status(checked.status).json({ error: checked.error, message: checked.message });
      return;
    }
    const result = await publishSpecialDay({
      shopId: req.shop!.id,
      timezone: checked.timezone,
      bufferMin: checked.bufferMin,
      spec: checked.spec,
      serviceIds: checked.serviceIds,
      price: d.price,
      name: d.name?.trim() || null,
      requestId: d.requestId ?? null,
      expectOpenings: d.expectOpenings ?? null,
      now: new Date(),
    });
    if (result.ok) {
      res.status(result.replay ? 200 : 201).json({ ok: true, replay: result.replay, created: result.created });
      return;
    }
    if (result.error === "already_exists") {
      res.status(409).json({
        error: "already_exists",
        staffIds: result.staffIds,
        message: "That chair already has a special day on that date. Remove it first to change it.",
      });
      return;
    }
    res.status(409).json({
      error: result.error,
      message:
        result.error === "changed"
          ? "Something on the calendar changed since the preview. Check the new preview, then publish."
          : "Every opening overlaps something already booked or blocked, so there is nothing to publish.",
      plans: plansJson(result.plans),
    });
  });

  /**
   * GET /special-days/day?date=YYYY-MM-DD - the LIVE VIEW of one date: every
   * chair's bookings, Acuity time, blocked time and special openings, in
   * shop-local minutes (engines/specialDayView.ts). Read-only.
   */
  router.get("/special-days/day", async (req, res) => {
    const date = DAY_KEY.safeParse(req.query.date);
    if (!date.success) {
      res.status(400).json({ error: "invalid_input", issues: date.error.issues });
      return;
    }
    const shopId = req.shop!.id;
    const shop = await liveViewShop(shopId, date.data);
    if (!shop.ok) {
      res.status(shop.status).json({ error: shop.error, message: shop.message });
      return;
    }
    const view = await loadDayView({
      shopId,
      timezone: shop.timezone,
      bufferMin: shop.bufferMin,
      date: date.data,
      staffIds: shop.staffIds,
      now: new Date(),
    });
    res.json({ view });
  });

  /**
   * PUT /special-days/day - save the live view: each listed chair's openings
   * become exactly the ones sent (booked openings always stay as booked), and
   * the rest of that chair's day is closed. One transaction under the chairs'
   * calendar locks; 409 `changed` (with the fresh view) when the day moved
   * since the view was read; a repeated requestId replays.
   */
  router.put("/special-days/day", async (req, res) => {
    const parsed = liveSaveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const shopId = req.shop!.id;
    const shop = await liveViewShop(shopId, d.date);
    if (!shop.ok) {
      res.status(shop.status).json({ error: shop.error, message: shop.message });
      return;
    }
    const serviceIds = [...new Set(d.serviceIds)];
    const chairIds = d.chairs.map((c) => c.staffId);
    const known = new Set(shop.staffIds);
    if (new Set(chairIds).size !== chairIds.length || chairIds.some((id) => !known.has(id))) {
      res.status(400).json({ error: "invalid_input", message: "Pick people from this shop." });
      return;
    }
    if (serviceIds.length > 0) {
      const found = await forShop(shopId).service.count({ where: { id: { in: serviceIds }, active: true } });
      if (found !== serviceIds.length) {
        res.status(400).json({ error: "invalid_input", message: "Pick services from this shop." });
        return;
      }
    }
    const out = await saveDay({
      shopId,
      timezone: shop.timezone,
      bufferMin: shop.bufferMin,
      date: d.date,
      staffIds: shop.staffIds,
      chairs: d.chairs,
      serviceIds,
      name: d.name?.trim() || null,
      requestId: d.requestId ?? null,
      basis: d.basis,
      now: new Date(),
      overOwnBlocks: d.overOwnBlocks === true,
    });
    if (out.ok) {
      res.json({ ok: true, replay: out.replay, summary: out.summary, view: out.view });
      return;
    }
    if (out.error === "changed") {
      res.status(409).json({
        error: "changed",
        message: "Something on this day changed since you opened it. Nothing was saved - check the day, then save again.",
        view: out.view,
      });
      return;
    }
    const hh = String(Math.floor(out.startMin / 60)).padStart(2, "0");
    const mm = String(out.startMin % 60).padStart(2, "0");
    res.status(400).json({
      error: "invalid_opening",
      staffId: out.staffId,
      startMin: out.startMin,
      reason: out.reason,
      message: `The opening at ${hh}:${mm} can't be saved: ${REFUSAL_WORDS[out.reason] ?? "it doesn't fit"}. Nothing was saved.`,
    });
  });

  /** POST /special-days/remove - take special days down; booked openings stay. */
  router.post("/special-days/remove", async (req, res) => {
    const parsed = z
      .object({ ruleIds: z.array(z.string().min(1)).min(1).max(MAX_SPECIAL_DAY_CHAIRS * 4) })
      .strict()
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
      return;
    }
    const out = await removeSpecialDays(req.shop!.id, parsed.data.ruleIds);
    if (out.removed === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ok: true, ...out });
  });
}
