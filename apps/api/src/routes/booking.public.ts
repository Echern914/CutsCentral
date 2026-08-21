import { Router } from "express";
import { z } from "zod";
import { apiEnv, randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { prisma, Prisma } from "@chairback/db";
import { deriveAcuityClientKey, toE164 } from "../acuity/clientKey.js";
import { computeOpenSlots, isSlotBookable } from "../engines/slots.js";
import {
  blockedRangesByStaff,
  dropBlockedTargetedSlots,
  staffSpanBlocked,
} from "../engines/blockedTime.js";
import { lockStaffAndAssertSlotFree, SlotTakenError } from "../engines/bookingWrite.js";
import { ServiceDayFullError } from "../engines/serviceDailyLimit.js";
import { resolveAddOns } from "../engines/addOns.js";
import {
  durationRangeForService,
  effectiveDurationAt,
  effectivePriceAt,
  parseDurationOverrides,
  parsePriceOverrides,
  parseTimeWindows,
  priceRangeForService,
} from "../engines/pricing.js";
import { connectEnabled, hasActiveAccess } from "../billing/stripe.js";
import {
  createAheadPaymentIntent,
  depositChargeCents,
  toCents,
} from "../billing/payments.js";
import {
  notifyAppointmentConfirmation,
  notifyBarberBookingEvent,
  publicBookingEmailRequired,
} from "../services/appointmentNotify.js";
import { sendPushToUser } from "../messaging/push.js";
import { cancelAppointment } from "../engines/appointmentPromotion.js";
import {
  rewardsLimiter,
  bookingReadLimiter,
  bookingWriteLimiter,
} from "../middleware/rateLimit.js";
import { logger } from "../logger.js";

/**
 * PUBLIC native booking API. UNauthenticated - the slug resolves the shop and a
 * manageToken authorizes cancel/reschedule (no login), the same trust model as
 * the rewards (magicToken) and lead/review (slug) routes.
 *
 * Every shop read/insert uses plain `prisma` (the connection owner), which
 * bypasses FORCE RLS - exactly like the appointment-request / review writes. The
 * barber reads/manages these through forShop() (RLS-enforced) in the dashboard
 * router. The booking insert is a single transaction with an overlap row-lock;
 * the partial unique (staffId, startsAt) WHERE status='BOOKED' is the backstop.
 *
 * A 404 is returned for any shop that isn't live + native (no oracle).
 */
export const bookingPublicRouter: Router = Router();

// z.coerce.date() turns an unparseable string into an Invalid Date that still
// passes instanceof checks (its getTime() is NaN, which then slips through
// numeric bound comparisons). Refine to a real date so bad input is a clean 400.
const validDate = z.coerce.date().refine((dt) => !Number.isNaN(dt.getTime()), {
  message: "Invalid date.",
});

/**
 * Drop targeted slots that fall on blocked time (one-off exception, recurring
 * break, or Acuity-synced block) for their own staff. Every public surface
 * that reads TargetedSlot rows goes through here so none can drift: the flat
 * payload, the /day chips, and the open-days sweep. The covering time range is
 * computed from the rows themselves, so callers can't under-fetch blocks.
 */
async function filterBlockedTargeted<
  T extends { staffId: string; startsAt: Date; durationMin: number },
>(shopId: string, timezone: string, slots: T[]): Promise<T[]> {
  if (slots.length === 0) return slots;
  let fromMs = Number.POSITIVE_INFINITY;
  let toMs = Number.NEGATIVE_INFINITY;
  for (const t of slots) {
    fromMs = Math.min(fromMs, t.startsAt.getTime());
    toMs = Math.max(toMs, t.startsAt.getTime() + t.durationMin * 60_000);
  }
  const blocked = await blockedRangesByStaff({
    shopId,
    staffIds: slots.map((t) => t.staffId),
    fromMs,
    toMs,
    timezone,
  });
  return dropBlockedTargetedSlots(slots, blocked);
}

/** Resolve a live, native-booking shop by slug, or null. */
async function resolveNativeShop(slugRaw: string | undefined) {
  const slug = String(slugRaw).toLowerCase();
  const shop = await prisma.shop.findUnique({ where: { slug } });
  if (!shop || !shop.publicPageEnabled || shop.bookingMode !== "native") {
    return null;
  }
  return shop;
}

// GET /api/book/:slug - shop meta + active staff + active services.
bookingPublicRouter.get("/:slug", bookingReadLimiter, async (req, res) => {
  const shop = await resolveNativeShop(req.params.slug);
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const [staff, services, links, addOns, rawTargetedSlots, groups, availRules] = await Promise.all([
    prisma.staff.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, bio: true, imageUrl: true },
    }),
    prisma.service.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        description: true,
        imageUrl: true,
        color: true,
        durationMin: true,
        durationOverrides: true,
        timeOverrides: true,
        price: true,
        priceOverrides: true,
        dateOverrides: true,
        // Groups-first layout: which group card the service files under and
        // its saved position within that group.
        serviceGroupId: true,
        groupSortOrder: true,
      },
    }),
    prisma.serviceStaff.findMany({
      where: { shopId: shop.id },
      select: { serviceId: true, staffId: true },
    }),
    prisma.serviceAddOn.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, durationMin: true, price: true, serviceIds: true },
    }),
    // Barber-published targeted slots: future, active, still unbooked. Shown
    // under their parent service with a badge + THEIR price.
    prisma.targetedSlot.findMany({
      where: {
        shopId: shop.id,
        active: true,
        bookedAppointmentId: null,
        startsAt: { gt: new Date() },
      },
      orderBy: { startsAt: "asc" },
      take: 100,
      select: {
        id: true,
        staffId: true,
        serviceId: true,
        label: true,
        startsAt: true,
        durationMin: true,
        price: true,
      },
    }),
    // Service groups for the optional groups-first menu layout.
    prisma.serviceGroup.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true },
    }),
    // Weekly availability rules — the day-first calendar marks weekdays anyone
    // works as pickable (real slots are fetched per day on tap).
    prisma.availabilityRule.findMany({
      where: { shopId: shop.id },
      select: { weekday: true, staffId: true },
    }),
  ]);
  const activeStaffIds = new Set(staff.map((s) => s.id));
  const openWeekdays = [
    ...new Set(
      availRules.filter((r) => activeStaffIds.has(r.staffId)).map((r) => r.weekday),
    ),
  ];
  // BLOCKED TIME WINS over published specials: drop any targeted slot whose
  // span the barber has since blocked off (one-off, recurring, or synced from
  // Acuity). The grid subtracts these inside the engine; specials are appended
  // from their own table, so they need the same subtraction here or a weekly
  // special keeps selling chips straight through a blocked vacation week.
  const targetedSlots = await filterBlockedTargeted(shop.id, shop.timezone, rawTargetedSlots);
  res.json({
    shop: {
      name: shop.name,
      slug: shop.slug,
      timezone: shop.timezone,
      logoUrl: shop.logoUrl,
      accentColor: shop.accentColor,
      // Stored without the "@" (stripped on save). The shop mini-site has shown
      // this since it shipped; the booking page — which is the link barbers
      // actually put in their Instagram bio — never did, so the traffic arrived
      // from Instagram with no way back to it.
      instagramHandle: shop.instagramHandle,
      bookingLeadHours: shop.bookingLeadHours,
      bookingMaxDays: shop.bookingMaxDays,
      // Lapsed shops can't take bookings (the create POST 403s) - tell the UI
      // up front so a customer isn't walked through the whole flow into a
      // dead-end at the final submit.
      bookingPaused: !hasActiveAccess(shop),
      // When on, the booking page offers "Join the waitlist" (a standing button
      // and when a day is fully booked).
      waitlistEnabled: shop.waitlistEnabled,
      // The form marks Email required when true, so the customer finds out at
      // the field rather than at submit. The server enforces it regardless.
      emailRequired: publicBookingEmailRequired(),
      // When on (and groups exist), the menu shows group cards first instead
      // of every service "off rip".
      groupsFirst: shop.bookingGroupsFirst,
      // Fee-free pay-direct handles (display-only) so the confirmation screen can
      // show "pay the barber directly". Only surfaced when the barber enabled it.
      payDirect: shop.payDirectEnabled
        ? {
            zelle: shop.payDirectZelle,
            venmo: shop.payDirectVenmo,
            cashApp: shop.payDirectCashApp,
            note: shop.payDirectNote,
          }
        : null,
    },
    staff,
    services: services.map((s) => {
      const base = s.price === null ? null : Number(s.price);
      const overrides = parsePriceOverrides(s.priceOverrides);
      const durOverrides = parseDurationOverrides(s.durationOverrides);
      const timeWindows = parseTimeWindows(s.timeOverrides);
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        // Per-service booking-card photo (https URL) + calendar color KEY. Both
        // purely cosmetic on the public card: the photo is a menu thumbnail, the
        // color a subtle left-edge accent matching the barber's calendar coding.
        imageUrl: s.imageUrl,
        color: s.color,
        durationMin: s.durationMin,
        price: base,
        // Per-weekday overrides ({weekday: price}); the client computes the exact
        // price for the day the customer picks (in the shop tz). priceRange lets
        // the menu show "from $X" / "$45-$55" before a day is chosen.
        priceOverrides: overrides,
        priceRange: priceRangeForService(base, {
          weekdayOverrides: overrides,
          timeWindows,
        }),
        // Same idea for duration ({weekday: minutes}) - the menu can show
        // "20-30 min" and the picker the exact length for the chosen day.
        durationOverrides: durOverrides,
        durationRange: durationRangeForService(s.durationMin, {
          weekdayOverrides: durOverrides,
          timeWindows,
        }),
        // Time-of-day windows ([{s,e,price?,durationMin?}], shop-local minutes,
        // every day) - the client resolves each slot's exact price/length from
        // the SLOT time so an evening special is shown before it's tapped.
        timeOverrides: timeWindows,
        // Groups-first layout: which group card this files under + its saved
        // position inside that group.
        serviceGroupId: s.serviceGroupId,
        groupSortOrder: s.groupSortOrder,
      };
    }),
    // Group cards for the optional groups-first menu (shop.groupsFirst).
    groups,
    // Weekdays (0-6, shop-local) with any staff availability at all — the
    // day-first calendar's "pickable day" heuristic.
    openWeekdays,
    // The (service, staff) offering matrix so the UI can filter either way.
    offerings: links,
    // One-off special slots, listed under their parent service in the picker.
    targetedSlots: targetedSlots.map((t) => ({
      id: t.id,
      staffId: t.staffId,
      serviceId: t.serviceId,
      label: t.label,
      startsAt: t.startsAt.toISOString(),
      durationMin: t.durationMin,
      price: Number(t.price),
    })),
    // Optional add-ons. serviceIds [] = offered on every service; non-empty =
    // only with those. The client shows the ones valid for the chosen service.
    addOns: addOns.map((a) => ({
      id: a.id,
      name: a.name,
      durationMin: a.durationMin,
      price: a.price === null ? null : Number(a.price),
      serviceIds: a.serviceIds,
    })),
  });
});

// GET /api/book/:slug/slots?staffId=&serviceId=&from=&to= - open slots.
const slotsQuerySchema = z.object({
  staffId: z.string().min(1),
  serviceId: z.string().min(1),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

bookingPublicRouter.get("/:slug/slots", bookingReadLimiter, async (req, res) => {
  const shop = await resolveNativeShop(req.params.slug);
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const parsed = slotsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const now = new Date();
  const from = parsed.data.from ?? now;
  // Default to the shop's max horizon when `to` is omitted.
  const to =
    parsed.data.to ??
    new Date(now.getTime() + shop.bookingMaxDays * 24 * 60 * 60 * 1000);
  const slots = await computeOpenSlots({
    shopId: shop.id,
    staffId: parsed.data.staffId,
    serviceId: parsed.data.serviceId,
    fromDate: from,
    toDate: to,
    now,
  });
  res.json({
    timezone: shop.timezone,
    slots: slots.map((s) => ({
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
    })),
  });
});

// GET /api/book/:slug/day?date=YYYY-MM-DD — everything bookable on ONE
// shop-local day, grouped by bundle (service group), for the day-first menu:
// the customer picks a DATE, then sees only the bundles with availability that
// day and the concrete open times inside each. Services/bundles with nothing
// open that day are omitted entirely. Price + duration are resolved for THAT
// day (weekday overrides), and the day's unbooked targeted slots ride along
// under their parent service with their own price.
const dayQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// Same cost story as /open-days below: one computeOpenSlots per staff×service
// pair, so an uncached /day is the most expensive read on the API. Cached
// in-process for 60s per shop+date (same freshness tradeoff as /open-days),
// and the per-service fan-out is capped — each computeOpenSlots holds a pooled
// connection for its whole interactive transaction, so an UNbounded
// Promise.all over a big menu could grab ~services-count connections from the
// shared pool (connection_limit=10) in one request and starve every tenant.
// TTL 0 under vitest (same pattern as middleware/rateLimit.ts): suites edit
// hours/services and immediately re-read the day, and serving the pre-edit
// body would fail them for a staleness prod explicitly accepts.
const DAY_TTL_MS = process.env.VITEST === "true" ? 0 : 60_000;
const dayCache = new Map<string, { at: number; body: unknown }>();
// Day sweeps CURRENTLY RUNNING, keyed by shop|date. Same reasoning as the
// open-days in-flight map below: the cache holds only finished bodies, so
// without this a burst of visitors on one date each runs the whole sweep.
const dayInFlight = new Map<string, Promise<unknown>>();
const DAY_FANOUT_LIMIT = 4;

/**
 * Drop a shop's cached availability (every /day date + /open-days) after any
 * write that can change what's bookable.
 *
 * Public booking writes call it so the customer who loses a slot race sees the
 * dead chip disappear instead of looping on slot_taken until the TTL lapses.
 *
 * DASHBOARD writes call it too (via the invalidation hook on the booking
 * dashboard router): a barber's verify loop is "save hours -> open my booking
 * page -> check" and that happens in SECONDS. Serving him the pre-save times
 * for up to a minute reads as "it didn't save" — the single most damaging
 * thing a save can look like, and precisely the complaint that surfaced on
 * launch day. Availability edits are rare and this is one Map delete, so
 * there's no reason to make the barber wait out a TTL to see his own change.
 */
export function invalidateShopAvailabilityCaches(shopId: string): void {
  for (const key of dayCache.keys()) {
    if (key.startsWith(`${shopId}|`)) dayCache.delete(key);
  }
  openDaysCache.delete(shopId);
}

/** Map with at most `limit` calls of `fn` in flight at once (order preserved). */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

bookingPublicRouter.get("/:slug/day", bookingReadLimiter, async (req, res) => {
  const shop = await resolveNativeShop(req.params.slug);
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const parsed = dayQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const [y, m, d] = parsed.data.date.split("-").map(Number) as [number, number, number];
  const dayStart = zonedWallTimeToUtc(y, m - 1, d, 0, shop.timezone);
  const dayEnd = zonedWallTimeToUtc(y, m - 1, d + 1, 0, shop.timezone);
  const now = new Date();
  const horizon = new Date(now.getTime() + shop.bookingMaxDays * 24 * 60 * 60 * 1000);
  // Outside the bookable window: an empty (not error) day, so the calendar can
  // page freely without special-casing.
  if (dayEnd.getTime() <= now.getTime() || dayStart.getTime() > horizon.getTime()) {
    res.json({ timezone: shop.timezone, date: parsed.data.date, bundles: [], ungrouped: [] });
    return;
  }
  // Cache AFTER the horizon check: out-of-window days are cheap empties, and
  // keying by shop.id (not the raw slug) avoids case-variant duplicate entries.
  const dayCacheKey = `${shop.id}|${parsed.data.date}`;
  const dayCached = dayCache.get(dayCacheKey);
  if (dayCached && Date.now() - dayCached.at < DAY_TTL_MS) {
    res.json(dayCached.body);
    return;
  }

  const inFlightDay = dayInFlight.get(dayCacheKey);
  if (inFlightDay) {
    res.json(await inFlightDay);
    return;
  }
  const dayWork = computeDayBody(shop, parsed.data.date, dayStart, dayEnd, now);
  dayInFlight.set(dayCacheKey, dayWork);
  try {
    res.json(await dayWork);
  } finally {
    dayInFlight.delete(dayCacheKey);
  }
});

/**
 * One day's bundles. Factored out of the route so concurrent callers can share
 * ONE run: the cache above only holds FINISHED bodies, so a burst of visitors
 * landing on the same date each used to start their own full service x staff
 * sweep - the shape that starves a fixed connection pool. Measured on prod:
 * three simultaneous requests for one uncached day took 5.7s / 6.2s / 7.4s,
 * each doing the whole job.
 */
async function computeDayBody(
  shop: NonNullable<Awaited<ReturnType<typeof resolveNativeShop>>>,
  date: string,
  dayStart: Date,
  dayEnd: Date,
  now: Date,
): Promise<unknown> {
  const dayCacheKey = `${shop.id}|${date}`;
  const [services, links, groups, rawTargeted] = await Promise.all([
    prisma.service.findMany({
      where: { shopId: shop.id, active: true },
      // groupSortOrder first so each bundle's members come out in saved order.
      orderBy: [{ groupSortOrder: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        description: true,
        imageUrl: true,
        color: true,
        durationMin: true,
        durationOverrides: true,
        timeOverrides: true,
        price: true,
        priceOverrides: true,
        dateOverrides: true,
        serviceGroupId: true,
      },
    }),
    prisma.serviceStaff.findMany({
      where: { shopId: shop.id },
      select: { serviceId: true, staffId: true },
    }),
    prisma.serviceGroup.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true },
    }),
    prisma.targetedSlot.findMany({
      where: {
        shopId: shop.id,
        active: true,
        bookedAppointmentId: null,
        // Floor at NOW when the requested day is today - the flat payload
        // (GET /:slug) filters gt: now, and the booking POST rejects
        // startsAt <= now, so a passed same-day special must not render as
        // a tappable chip that can only ever 409.
        startsAt: {
          ...(dayStart.getTime() > now.getTime() ? { gte: dayStart } : { gt: now }),
          lt: dayEnd,
        },
      },
      orderBy: { startsAt: "asc" },
      select: {
        id: true,
        staffId: true,
        serviceId: true,
        label: true,
        startsAt: true,
        durationMin: true,
        price: true,
      },
    }),
  ]);

  // Blocked time wins: a special chip must not render on a span the barber has
  // blocked off (the grid slots below already honor blocks inside the engine).
  const targeted = await filterBlockedTargeted(shop.id, shop.timezone, rawTargeted);

  // Per service: union the open slots across every staff who offers it (same
  // merge the client does for the per-service calendar, done server-side here
  // because the day view spans EVERY service at once).
  interface DaySlotOut {
    startsAt: string;
    staffIds: string[];
    targeted?: { id: string; price: number; label: string | null };
    // Present ONLY when a time-of-day window makes this slot differ from the
    // service's day-level price/durationMin (e.g. the 9pm chip is $65/20 min
    // while the day runs $45/30 min) - the UI badges just those chips.
    price?: number | null;
    durationMin?: number;
  }
  const staffByService = new Map<string, string[]>();
  for (const l of links) {
    staffByService.set(l.serviceId, [...(staffByService.get(l.serviceId) ?? []), l.staffId]);
  }
  const midDay = new Date((dayStart.getTime() + dayEnd.getTime()) / 2);

  async function dayFor(service: (typeof services)[number]) {
    const staffIds = staffByService.get(service.id) ?? [];
    const merged = new Map<string, string[]>();
    for (const staffId of staffIds) {
      const slots = await computeOpenSlots({
        shopId: shop!.id,
        staffId,
        serviceId: service.id,
        fromDate: dayStart.getTime() > now.getTime() ? dayStart : now,
        toDate: dayEnd,
        now,
      });
      for (const s of slots) {
        const key = s.startsAt.toISOString();
        merged.set(key, [...(merged.get(key) ?? []), staffId]);
      }
    }
    // Day-level price/duration resolve the WEEKDAY layer only (timeWindows:
    // null): time-of-day windows are slot-scoped, and midday falling inside a
    // window (a lunch special) must not relabel the whole day's card.
    const dayDuration = effectiveDurationAt(service.durationMin, {
      at: midDay,
      timezone: shop!.timezone,
      weekdayOverrides: service.durationOverrides,
      timeWindows: null,
    });
    const dayPrice = effectivePriceAt(
      service.price === null ? null : Number(service.price),
      {
        at: midDay,
        timezone: shop!.timezone,
        weekdayOverrides: service.priceOverrides,
      dateOverrides: service.dateOverrides,
        timeWindows: null,
      },
    );
    const out: DaySlotOut[] = [...merged.entries()]
      .map(([startsAt, ids]): DaySlotOut => {
        const slot: DaySlotOut = { startsAt, staffIds: ids };
        // Full-layer resolve for THIS slot's start instant; attach only when a
        // window makes it differ from the day-level values, so the payload (and
        // the UI's badging rule) stay exactly as before for window-less shops.
        const at = new Date(startsAt);
        const slotPrice = effectivePriceAt(
          service.price === null ? null : Number(service.price),
          {
            at,
            timezone: shop!.timezone,
            weekdayOverrides: service.priceOverrides,
      dateOverrides: service.dateOverrides,
            timeWindows: service.timeOverrides,
          },
        );
        const slotDuration = effectiveDurationAt(service.durationMin, {
          at,
          timezone: shop!.timezone,
          weekdayOverrides: service.durationOverrides,
          timeWindows: service.timeOverrides,
        });
        if (slotPrice !== dayPrice) slot.price = slotPrice;
        if (slotDuration !== dayDuration) slot.durationMin = slotDuration;
        return slot;
      })
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    // The day's targeted specials for this service, at THEIR price.
    for (const t of targeted.filter((t) => t.serviceId === service.id)) {
      out.push({
        startsAt: t.startsAt.toISOString(),
        staffIds: [t.staffId],
        targeted: { id: t.id, price: Number(t.price), label: t.label },
      });
    }
    out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    if (out.length === 0) return null;
    return {
      id: service.id,
      name: service.name,
      description: service.description,
      imageUrl: service.imageUrl,
      color: service.color,
      durationMin: dayDuration,
      price: dayPrice,
      slots: out,
    };
  }

  const dayServices = (
    await mapWithLimit(services, DAY_FANOUT_LIMIT, (s) => dayFor(s))
  ).filter((s): s is NonNullable<typeof s> => s !== null);
  const byId = new Map(dayServices.map((s) => [s.id, s]));
  const bundles = groups
    .map((g) => ({
      id: g.id,
      name: g.name,
      services: services
        .filter((s) => s.serviceGroupId === g.id)
        .map((s) => byId.get(s.id))
        .filter((s): s is NonNullable<typeof s> => Boolean(s)),
    }))
    .filter((g) => g.services.length > 0);
  const groupedIds = new Set(bundles.flatMap((b) => b.services.map((s) => s.id)));
  const ungrouped = dayServices.filter((s) => !groupedIds.has(s.id));

  const dayBody = { timezone: shop.timezone, date, bundles, ungrouped };
  dayCache.set(dayCacheKey, { at: Date.now(), body: dayBody });
  return dayBody;
}

/**
 * GET /api/book/:slug/upgrades?startsAt=&staffId=&serviceId=
 *
 * "You picked the 4:00 — you actually have room for more." Given a slot the
 * customer just tapped, returns the LONGER, pricier services that are genuinely
 * bookable at that exact instant with that same barber, plus the spare minutes
 * after the chosen service (which is what decides which add-ons fit).
 *
 * WHY THIS IS A ROUND TRIP AND NOT ARITHMETIC ON THE PAGE. It is tempting to
 * take the gap and offer anything shorter than it. That fails open twice over:
 *
 *   1. THE GRID. computeOpenSlots steps each service by its OWN effective
 *      duration from the window start, and the booking POST validates via
 *      isSlotBookable, which requires the requested time to be a member of that
 *      service's grid. A 30-min service offers 9:00/9:30/10:00; a 60-min one
 *      offers 9:00/10:00. Offering "upgrade to the 60" on the 9:30 chip yields
 *      a slot the POST turns around and rejects with invalid_slot - the
 *      customer gets a dead end at the last step, which is the worst possible
 *      place to find out.
 *   2. SERVICE HOURS AND CAPS. A service can be narrower than the barber's
 *      hours and can sit in a group with maxPerDay/maxConcurrent. Both live
 *      inside the engine. Room in the calendar says nothing about either.
 *
 * So each candidate is confirmed by the engine itself, with booked time
 * subtracted (unlike isSlotBookable, which deliberately ignores it and leaves
 * conflicts to the write tx): a longer service runs past the chosen slot's end,
 * so it is exactly the case where the NEXT appointment matters.
 *
 * Cost is bounded on both sides: candidates that cannot fit the raw gap are
 * dropped for free before any query, and what survives is capped and fanned out
 * through the same limiter /day uses.
 */
const upgradesQuerySchema = z.object({
  startsAt: z.string().min(1),
  staffId: z.string().min(1),
  serviceId: z.string().min(1),
});

/** Engine runs we'll spend confirming candidates (each is one scoped tx). */
const UPGRADE_CHECK_LIMIT = 4;

bookingPublicRouter.get("/:slug/upgrades", bookingReadLimiter, async (req, res) => {
  const shop = await resolveNativeShop(req.params.slug);
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const parsed = upgradesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const startsAt = new Date(parsed.data.startsAt);
  if (Number.isNaN(startsAt.getTime())) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const now = new Date();
  // An upsell is a suggestion, never a gate: anything we can't answer comes
  // back as "no suggestions" rather than an error the page has to render.
  const empty = { maxExtraMin: 0, upgrades: [] as unknown[] };
  if (startsAt.getTime() <= now.getTime()) {
    res.json(empty);
    return;
  }

  const [services, links] = await Promise.all([
    prisma.service.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        description: true,
        durationMin: true,
        durationOverrides: true,
        price: true,
        priceOverrides: true,
        dateOverrides: true,
        timeOverrides: true,
      },
    }),
    prisma.serviceStaff.findMany({
      where: { shopId: shop.id, staffId: parsed.data.staffId },
      select: { serviceId: true },
    }),
  ]);
  const chosen = services.find((s) => s.id === parsed.data.serviceId);
  if (!chosen) {
    res.json(empty);
    return;
  }

  /** Effective duration/price for a service at THIS slot's instant. */
  const durationOf = (s: (typeof services)[number]): number =>
    effectiveDurationAt(s.durationMin, {
      at: startsAt,
      timezone: shop.timezone,
      weekdayOverrides: s.durationOverrides,
      timeWindows: s.timeOverrides,
    });
  const priceOf = (s: (typeof services)[number]): number | null =>
    effectivePriceAt(s.price === null ? null : Number(s.price), {
      at: startsAt,
      timezone: shop.timezone,
      weekdayOverrides: s.priceOverrides,
      dateOverrides: s.dateOverrides,
      timeWindows: s.timeOverrides,
    });

  // Confirm the customer's own slot is real (a stale page can ask about a time
  // that has since been taken) and learn its spare room from the same pass.
  const mineSlots = await computeOpenSlots({
    shopId: shop.id,
    staffId: parsed.data.staffId,
    serviceId: chosen.id,
    fromDate: new Date(startsAt.getTime() - 24 * 60 * 60_000),
    toDate: new Date(startsAt.getTime() + 24 * 60 * 60_000),
    now,
  });
  const mine = mineSlots.find((s) => s.startsAt.getTime() === startsAt.getTime());
  if (!mine) {
    res.json(empty);
    return;
  }
  const room = mine.maxExtraMin;

  const chosenDuration = durationOf(chosen);
  const chosenPrice = priceOf(chosen);
  const offered = new Set(links.map((l) => l.serviceId));

  // An UPGRADE is longer AND dearer. Longer, because the whole premise is
  // "there's time going spare"; dearer, because a longer service for the same
  // money isn't an upsell, it's just a different booking. An unpriced menu
  // gets no suggestions rather than a guessed comparison against 0.
  const candidates =
    chosenPrice === null
      ? []
      : services
          .filter((s) => {
            if (s.id === chosen.id || !offered.has(s.id)) return false;
            const p = priceOf(s);
            if (p === null || p <= chosenPrice) return false;
            const d = durationOf(s);
            // Free prefilter: anything that can't fit the raw gap can't fit,
            // full stop - no need to spend an engine run finding that out.
            return d > chosenDuration && d - chosenDuration <= room;
          })
          // Gentlest step up first: the nearest upgrade is the believable one.
          .sort((a, b) => (priceOf(a) ?? 0) - (priceOf(b) ?? 0))
          .slice(0, UPGRADE_CHECK_LIMIT);

  const confirmed = (
    await mapWithLimit(candidates, DAY_FANOUT_LIMIT, async (s) => {
      const slots = await computeOpenSlots({
        shopId: shop.id,
        staffId: parsed.data.staffId,
        serviceId: s.id,
        fromDate: new Date(startsAt.getTime() - 24 * 60 * 60_000),
        toDate: new Date(startsAt.getTime() + 24 * 60 * 60_000),
        now,
      });
      const fits = slots.some((x) => x.startsAt.getTime() === startsAt.getTime());
      if (!fits) return null;
      const price = priceOf(s)!;
      return {
        serviceId: s.id,
        name: s.name,
        description: s.description,
        durationMin: durationOf(s),
        price,
        // What the customer actually weighs: how much more, for how much longer.
        priceDelta: price - chosenPrice!,
        extraMin: durationOf(s) - chosenDuration,
      };
    })
  ).filter((u): u is NonNullable<typeof u> => u !== null);

  res.json({ maxExtraMin: room, upgrades: confirmed });
});

// GET /api/book/:slug/open-days — which shop-local days in the booking window
// have at least ONE bookable opening across any service, plus the single
// soonest slot overall. The day-first calendar used to offer days on a weekday
// heuristic ("anyone works Tuesdays"), which (a) auto-selected TODAY even when
// today's slots were all gone — every evening visitor landed on an empty day —
// and (b) never greyed a fully-booked or closed date ("grey out days not
// open" — Drick). Real availability, same engine as /day and the booking POST.
//
// Cost: one computeOpenSlots sweep per staff×service pair spanning the window
// (what the legacy per-service calendar paid per pick, summed) — so results
// are cached in-process for 60s per shop, same freshness tradeoff as the
// public shell's 30s cache. The scan is capped at 45 days: calendars beyond
// that fall back to the client's weekday heuristic, and the horizon check in
// the booking POST still rejects anything truly out of range.
// TTL 0 under vitest, same reason as the /day cache above.
const OPEN_DAYS_TTL_MS = process.env.VITEST === "true" ? 0 : 60_000;
const OPEN_DAYS_SCAN_CAP = 45;
// Keyed by shop.id (NOT the raw slug): the dashboard invalidator only knows the
// shop id, and a slug key also let case variants of the same slug each hold
// their own entry.
const openDaysCache = new Map<string, { at: number; body: unknown }>();
// Sweeps CURRENTLY RUNNING, keyed by shop. The cache above only holds FINISHED
// bodies, so on a cold cache every concurrent visitor used to kick off their own
// full sweep - each one holding OPEN_DAYS_FANOUT_LIMIT pooled connections
// (computeOpenSlots runs inside runWithShop), which with connection_limit=10 is
// how a popular shop starves its own database. Late arrivals now await the sweep
// already in flight and everyone gets the same body.
const openDaysInFlight = new Map<string, Promise<unknown>>();
// Concurrency for the service x staff sweep. Same bound and reasoning as
// DAY_FANOUT_LIMIT: enough to cut wall-clock hard, low enough that one request
// can't monopolize the connection pool.
const OPEN_DAYS_FANOUT_LIMIT = 4;
bookingPublicRouter.get("/:slug/open-days", bookingReadLimiter, async (req, res) => {
  const slug = req.params.slug!;
  const shop = await resolveNativeShop(slug);
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const cached = openDaysCache.get(shop.id);
  if (cached && Date.now() - cached.at < OPEN_DAYS_TTL_MS) {
    res.json(cached.body);
    return;
  }
  const inFlight = openDaysInFlight.get(shop.id);
  if (inFlight) {
    res.json(await inFlight);
    return;
  }
  const sweep = computeOpenDays(shop);
  openDaysInFlight.set(shop.id, sweep);
  try {
    res.json(await sweep);
  } finally {
    openDaysInFlight.delete(shop.id);
  }
});

/**
 * The actual open-days sweep, factored out so the route can share ONE run
 * between concurrent callers. Cold cost is the whole reason this page ever
 * showed a dead day: it was a strictly sequential nested await over every
 * service x staff pair across a 45-day window, which measured ~17.7s on a real
 * shop - past the web layer's 12s fetch abort, so the booking page decided real
 * availability was simply "unavailable" and fell back to a weekday heuristic
 * that happily lands on a today with nothing left. Bounded-parallel now.
 */
async function computeOpenDays(shop: {
  id: string;
  timezone: string;
  bookingMaxDays: number;
}): Promise<unknown> {
  const now = new Date();
  const scanDays = Math.min(shop.bookingMaxDays, OPEN_DAYS_SCAN_CAP);
  const toDate = new Date(now.getTime() + scanDays * 24 * 60 * 60 * 1000);
  const [services, links, rawTargeted] = await Promise.all([
    prisma.service.findMany({
      where: { shopId: shop.id, active: true },
      select: { id: true },
    }),
    prisma.serviceStaff.findMany({
      where: { shopId: shop.id },
      select: { serviceId: true, staffId: true },
    }),
    // Unbooked targeted specials count as openings too — a day whose only
    // availability is a published special must not render greyed.
    prisma.targetedSlot.findMany({
      where: {
        shopId: shop.id,
        active: true,
        bookedAppointmentId: null,
        startsAt: { gt: now, lt: toDate },
      },
      select: { startsAt: true, serviceId: true, staffId: true, durationMin: true },
    }),
  ]);
  // Blocked time wins: a special on a blocked span must not mark its day open
  // in the date strip (that was the vacation-week leak: the day rendered
  // pickable, then sold the special).
  const targeted = await filterBlockedTargeted(shop.id, shop.timezone, rawTargeted);
  const staffByService = new Map<string, string[]>();
  for (const l of links) {
    staffByService.set(l.serviceId, [
      ...(staffByService.get(l.serviceId) ?? []),
      l.staffId,
    ]);
  }
  // Shop-tz day keys, matching the client's YYYY-MM-DD calendar keys.
  const dayFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: shop.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const openDays = new Set<string>();
  let soonest: { startsAt: Date; serviceId: string; staffIds: string[] } | null =
    null;
  const consider = (startsAt: Date, serviceId: string, staffId: string) => {
    openDays.add(dayFmt.format(startsAt));
    if (!soonest || startsAt.getTime() < soonest.startsAt.getTime()) {
      soonest = { startsAt, serviceId, staffIds: [staffId] };
    } else if (
      startsAt.getTime() === soonest.startsAt.getTime() &&
      soonest.serviceId === serviceId &&
      !soonest.staffIds.includes(staffId)
    ) {
      soonest.staffIds.push(staffId); // same instant, same service: merged chip
    }
  };
  // Flatten to service x staff pairs, sweep them bounded-parallel, then fold
  // the results IN PAIR ORDER. Order matters: consider() merges equal-instant
  // hits into one chip and appends staffIds as it meets them, so consuming out
  // of order would shuffle which barber leads the "soonest" chip. mapWithLimit
  // preserves index order, so this is deterministic and matches the old nested
  // loop exactly.
  const pairs: { serviceId: string; staffId: string }[] = [];
  for (const svc of services) {
    for (const staffId of staffByService.get(svc.id) ?? []) {
      pairs.push({ serviceId: svc.id, staffId });
    }
  }
  const swept = await mapWithLimit(pairs, OPEN_DAYS_FANOUT_LIMIT, (p) =>
    computeOpenSlots({
      shopId: shop.id,
      staffId: p.staffId,
      serviceId: p.serviceId,
      fromDate: now,
      toDate,
      now,
    }),
  );
  pairs.forEach((p, i) => {
    for (const s of swept[i]!) consider(s.startsAt, p.serviceId, p.staffId);
  });
  for (const t of targeted) consider(t.startsAt, t.serviceId, t.staffId);
  const soonestOut = soonest as {
    startsAt: Date;
    serviceId: string;
    staffIds: string[];
  } | null;
  const body = {
    timezone: shop.timezone,
    scanDays,
    openDays: [...openDays].sort(),
    soonest: soonestOut
      ? {
          date: dayFmt.format(soonestOut.startsAt),
          startsAt: soonestOut.startsAt.toISOString(),
          serviceId: soonestOut.serviceId,
          staffIds: soonestOut.staffIds,
        }
      : null,
  };
  openDaysCache.set(shop.id, { at: Date.now(), body });
  return body;
}

// POST /api/book/:slug - create a booking. Tighter (lead) limiter: anti-spam.
const createSchema = z
  .object({
    staffId: z.string().min(1),
    serviceId: z.string().min(1),
    startsAt: validDate,
    firstName: z.string().trim().min(1).max(80),
    // REQUIRED on the public flow. Deliberately NOT required where the barber
    // books for someone (dashboard walk-ins, the SMS receptionist): those write
    // Appointment rows directly and a first name is often genuinely all he has.
    // A customer filling in his own details always knows his surname.
    lastName: z.string().trim().min(1).max(80),
    phone: z.string().trim().max(40).optional().or(z.literal("")),
    // REQUIRED while confirmation SMS is off - see publicBookingEmailRequired().
    // Email is then the only channel a customer is told their booking exists on,
    // so a blank one books them into silence. Enforced BELOW rather than with a
    // plain .min(1) so the message names the reason instead of "Required".
    email: z.string().trim().email().max(200).optional().or(z.literal("")),
    smsConsent: z.boolean().optional(),
    // Chosen service add-ons (ids). Invalid/foreign ids are dropped server-side.
    addOnIds: z.array(z.string().min(1)).max(20).optional(),
    // Booking a barber-published TARGETED slot: its id fixes the time, length,
    // and price (validated server-side against the slot row; capacity 1).
    targetedSlotId: z.string().min(1).optional(),
  })
  .strict()
  .refine((d) => Boolean(d.phone?.trim()) || Boolean(d.email?.trim()), {
    message: "Provide a phone or email.",
    path: ["phone"],
  })
  // Email is the confirmation channel while SMS is off, so "phone only" books
  // someone into silence. Enforced here, not just in the form: the form flag is
  // a hint a client could ignore - this is the rule.
  .refine((d) => !publicBookingEmailRequired() || Boolean(d.email?.trim()), {
    message: "We send your confirmation by email, so we need an address.",
    path: ["email"],
  });

bookingPublicRouter.post("/:slug", bookingWriteLimiter, async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const shop = await resolveNativeShop(req.params.slug);
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // SMS costs money - a shop without active access can't take native bookings.
  if (!hasActiveAccess(shop)) {
    res.status(403).json({ error: "no_active_access" });
    return;
  }
  const d = parsed.data;
  const phone = toE164(d.phone);
  // A non-empty but unparseable phone is a typo - refuse (same as the dashboard).
  if (d.phone?.trim() && !phone) {
    res.status(400).json({ error: "invalid_phone" });
    return;
  }

  // Validate staff offers an active service, compute the end time, bounds-check.
  const service = await prisma.service.findFirst({
    where: { id: d.serviceId, shopId: shop.id, active: true },
    select: {
      id: true,
      durationMin: true,
      durationOverrides: true,
      timeOverrides: true,
      price: true,
      priceOverrides: true,
        dateOverrides: true,
      name: true,
    },
  });
  const offering = await prisma.serviceStaff.findFirst({
    where: { shopId: shop.id, serviceId: d.serviceId, staffId: d.staffId },
    select: { id: true },
  });
  const staff = await prisma.staff.findFirst({
    where: { id: d.staffId, shopId: shop.id, active: true },
    select: { id: true },
  });
  if (!service || !offering || !staff) {
    res.status(400).json({ error: "invalid_slot" });
    return;
  }

  const now = new Date();
  const startsAt = d.startsAt;

  // Targeted slot: the barber-published row fixes time/length/price. Validated
  // here; the capacity-1 CLAIM happens inside the booking transaction below.
  let targeted: {
    id: string;
    startsAt: Date;
    durationMin: number;
    price: Prisma.Decimal;
  } | null = null;
  if (d.targetedSlotId) {
    const slot = await prisma.targetedSlot.findFirst({
      where: { id: d.targetedSlotId, shopId: shop.id },
      select: {
        id: true,
        staffId: true,
        serviceId: true,
        startsAt: true,
        durationMin: true,
        price: true,
        active: true,
        bookedAppointmentId: true,
      },
    });
    // Mismatched ids/time = a crafted POST -> 400. A real slot that's gone
    // (booked or deactivated) -> the clean "no longer available" 409.
    if (
      !slot ||
      slot.staffId !== d.staffId ||
      slot.serviceId !== d.serviceId ||
      slot.startsAt.getTime() !== startsAt.getTime()
    ) {
      res.status(400).json({ error: "invalid_slot" });
      return;
    }
    if (!slot.active || slot.bookedAppointmentId !== null || startsAt <= now) {
      res.status(409).json({ error: "slot_taken" });
      return;
    }
    // BLOCKED TIME WINS. A targeted slot deliberately bypasses hours and the
    // lead/max window (it is explicit barber inventory) — but a block is the
    // barber saying "I'm not there", and it beats his own standing special.
    // Without this, a crafted POST (or a chip served just before the block
    // landed) books straight into a blocked-off vacation day. 409 as
    // slot_taken: to the client it IS "no longer available".
    if (
      await staffSpanBlocked({
        shopId: shop.id,
        staffId: slot.staffId,
        startsAt: slot.startsAt,
        endsAt: new Date(slot.startsAt.getTime() + slot.durationMin * 60_000),
        timezone: shop.timezone,
      })
    ) {
      res.status(409).json({ error: "slot_taken" });
      return;
    }
    targeted = slot;
  }

  // Chosen add-ons extend the appointment + total. Invalid/foreign ids drop.
  // A targeted slot has a fixed length/price, so add-ons don't apply (v1).
  const addOns = targeted
    ? { snapshot: [], extraDurationMin: 0, extraPrice: 0 }
    : await resolveAddOns(shop.id, d.serviceId, d.addOnIds);
  // The duration for the SLOT the customer picked (time-of-day window, else
  // weekday override in the shop tz, else base) - a Friday 20-min cut books a
  // 20-min block, a 9pm in-window cut books the window's length. endsAt is the
  // duration snapshot: editing the service later never rewrites this row. A
  // targeted slot carries its own explicit length instead.
  const effectiveDuration = targeted
    ? targeted.durationMin
    : effectiveDurationAt(service.durationMin, {
        at: startsAt,
        timezone: shop.timezone,
        weekdayOverrides: service.durationOverrides,
        timeWindows: service.timeOverrides,
      });
  const endsAt = new Date(
    startsAt.getTime() + (effectiveDuration + addOns.extraDurationMin) * 60_000,
  );
  // Snapshot the price for the SLOT the customer picked (same layer order as
  // the duration above) - so a Sunday surcharge or a 9pm-window premium is
  // locked in at exactly what the customer was shown, not the base price.
  // Add-on prices are added on top. A targeted slot snapshots ITS price -
  // that's the whole point of the feature.
  const basePrice = targeted
    ? Number(targeted.price)
    : effectivePriceAt(service.price === null ? null : Number(service.price), {
        at: startsAt,
        timezone: shop.timezone,
        weekdayOverrides: service.priceOverrides,
      dateOverrides: service.dateOverrides,
        timeWindows: service.timeOverrides,
      });
  const effectivePrice =
    basePrice === null && addOns.extraPrice === 0
      ? null
      : (basePrice ?? 0) + addOns.extraPrice;
  // Bounds + availability apply to GRID slots only: a targeted slot is explicit
  // barber inventory - deliberately bookable outside the weekly hours and the
  // lead/max window (already validated: future, active, unbooked, exact time).
  if (!targeted) {
    const earliest = now.getTime() + shop.bookingLeadHours * 60 * 60_000;
    const latest = now.getTime() + shop.bookingMaxDays * 24 * 60 * 60_000;
    if (startsAt.getTime() < earliest) {
      res.status(400).json({ error: "too_soon" });
      return;
    }
    if (startsAt.getTime() > latest) {
      res.status(400).json({ error: "too_far" });
      return;
    }

    // Authoritative availability check: the requested time must be a REAL open
    // slot (inside the staff's hours, not on a blocked exception, honoring the
    // buffer). The browser's slot list is advisory; a crafted POST must not
    // bypass it. The extra add-on duration means the appointment needs a
    // bigger free window.
    if (
      !(await isSlotBookable({
        shopId: shop.id,
        staffId: d.staffId,
        serviceId: d.serviceId,
        startsAt,
        extraDurationMin: addOns.extraDurationMin,
      }))
    ) {
      res.status(400).json({ error: "invalid_slot" });
      return;
    }
  }

  const consented = d.smsConsent === true && Boolean(phone);
  const acuityClientKey = deriveAcuityClientKey({
    phone: d.phone,
    email: d.email,
    firstName: d.firstName,
    lastName: d.lastName,
  });

  let appointmentId: string;
  let manageToken: string;
  try {
    // One transaction as the connection owner (NO runWithShop - the public route
    // has no shop context). Availability was validated above; here the advisory
    // lock + overlap check guard against concurrent conflicts, and the partial
    // unique is the final backstop on an identical-start race.
    const result = await prisma.$transaction(async (tx) => {
      // Advisory lock + buffer-padded overlap re-check (throws SlotTakenError).
      // Shared with every other Appointment write - see engines/bookingWrite.ts
      // for the full protocol (and the PR #70 timestamp rule it encapsulates).
      await lockStaffAndAssertSlotFree(tx, {
        staffId: d.staffId,
        shopId: shop.id,
        startsAt,
        endsAt,
        bufferMin: shop.bookingBufferMin,
        // Booking INTO a targeted slot: its own block must not conflict with
        // this claim (any OTHER overlapping targeted slot still does).
        targetedSlotIdToIgnore: targeted?.id,
        // The public page IS the path the per-weekday cap exists for.
        serviceDayLimit: { serviceId: d.serviceId, timezone: shop.timezone },
        now,
      });

      // Upsert the client (tenant-scoped key). Stamp consent only when none is
      // recorded yet (first consent wins - never overwrite an earlier source).
      const client = await tx.client.upsert({
        where: {
          shopId_acuityClientKey: { shopId: shop.id, acuityClientKey },
        },
        create: {
          shopId: shop.id,
          acuityClientKey,
          magicToken: randomToken(),
          firstName: d.firstName,
          lastName: d.lastName || null,
          phone,
          email: d.email || null,
          source: "manual",
          smsConsentAt: consented ? now : null,
          smsConsentSource: consented ? "booking" : null,
        },
        update: {
          firstName: d.firstName,
          lastName: d.lastName || undefined,
          phone: phone ?? undefined,
          email: d.email || undefined,
        },
        select: { id: true },
      });
      if (consented) {
        await tx.client.updateMany({
          where: { id: client.id, smsConsentAt: null },
          data: { smsConsentAt: now, smsConsentSource: "booking" },
        });
      }

      const token = randomToken();
      const appt = await tx.appointment.create({
        data: {
          shopId: shop.id,
          staffId: d.staffId,
          serviceId: d.serviceId,
          clientId: client.id,
          firstName: d.firstName,
          lastName: d.lastName || null,
          phone,
          email: d.email || null,
          // Request-before-booking: land as PENDING (holds the slot, no
          // confirmation) until the barber approves; else confirm immediately.
          status: shop.requireBookingApproval ? "PENDING" : "BOOKED",
          startsAt,
          endsAt,
          priceAtBooking: effectivePrice ?? undefined,
          addOns: addOns.snapshot as unknown as Prisma.InputJsonValue,
          manageToken: token,
          bookedVia: targeted ? "targeted_slot" : undefined,
        },
        select: { id: true, manageToken: true },
      });

      // Capacity-1 claim: only the update that flips bookedAppointmentId from
      // NULL wins. The advisory lock already serialized same-staff racers, so
      // this is the correctness backstop (and covers a concurrent deactivate).
      // count 0 -> the slot was grabbed/killed since validation - roll back and
      // give the loser the same clean "no longer available" as slot_taken.
      if (targeted) {
        const claimed = await tx.targetedSlot.updateMany({
          where: { id: targeted.id, bookedAppointmentId: null, active: true },
          data: { bookedAppointmentId: appt.id },
        });
        if (claimed.count === 0) throw new SlotTakenError();
      }
      return appt;
    });
    appointmentId = result.id;
    manageToken = result.manageToken;
  } catch (err) {
    // The barber's cap for that weekday filled while this customer was on the
    // page. Its own code, not slot_taken: the time itself may well still be
    // free, so "pick another time today" would be wrong advice - the whole DAY
    // is done for this service.
    if (err instanceof ServiceDayFullError) {
      res.status(409).json({ error: "day_full" });
      return;
    }
    if (err instanceof SlotTakenError) {
      res.status(409).json({ error: "slot_taken" });
      return;
    }
    // P2002 = the partial-unique backstop fired on an identical-start race.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      res.status(409).json({ error: "slot_taken" });
      return;
    }
    logger.error({ err, shopId: shop.id }, "native booking create failed");
    res.status(500).json({ error: "create_failed" });
    return;
  }

  // Confirmation SMS after commit (gated by consent/quiet-hours/billing inside
  // notify; honors DRY_RUN). Fire-and-forget: a send issue must not fail the
  // booking, which is already durably saved. SKIPPED for an approval-required
  // request - the confirmation fires when the barber APPROVES it, not before.
  if (!shop.requireBookingApproval) {
    void notifyAppointmentConfirmation({ shopId: shop.id, appointmentId });
  }
  // Barber-side alert (push to the booked staffer's devices + notifyPhone SMS).
  // Fires for BOTH an instant booking and an approval request - the wording
  // adapts. Fire-and-forget after commit, like the confirmation above.
  void notifyBarberBookingEvent({
    shopId: shop.id,
    appointmentId,
    kind: shop.requireBookingApproval ? "requested" : "booked",
  });
  invalidateShopAvailabilityCaches(shop.id);

  // Pay-ahead: create a PaymentIntent for the customer to confirm (card/Apple
  // Pay) and return its client secret. Gated on the shop being in `ahead` mode
  // with a connected, charges-enabled account, Connect configured, and a real
  // price. AFTER commit (no Stripe call inside the booking tx). A failure here
  // never fails the booking — the customer falls back to paying in person.
  let payment: {
    clientSecret: string;
    amountCents: number;
    isDeposit: boolean;
    balanceDueCents: number;
  } | null = null;
  const fullCents = toCents(effectivePrice);
  // DEPOSIT charges a fixed amount now and leaves the rest for the chair; AHEAD
  // charges the whole ticket. Capped at the price either way, so a $20 deposit
  // can never overcharge a $15 line-up.
  const chargeCents =
    shop.paymentsMode === "deposit"
      ? depositChargeCents(shop.depositAmountCents, fullCents)
      : fullCents;
  if (
    connectEnabled() &&
    // Don't charge a card for a hold that may be declined - payment is
    // collected on/after approval (or the shop runs approval + pay-in-person).
    !shop.requireBookingApproval &&
    (shop.paymentsMode === "ahead" || shop.paymentsMode === "deposit") &&
    shop.connectChargesEnabled &&
    shop.stripeConnectAccountId &&
    chargeCents !== null
  ) {
    const isDeposit = shop.paymentsMode === "deposit" && chargeCents !== fullCents;
    const created = await createAheadPaymentIntent({
      shopId: shop.id,
      appointmentId,
      connectAccountId: shop.stripeConnectAccountId,
      amountCents: chargeCents,
      platformFeeBps: shop.platformFeeBps,
      // The customer reads this on the Apple Pay sheet and on their statement,
      // so it has to say WHICH this is - otherwise a deposit looks like a
      // mysteriously short charge for the whole cut.
      description: isDeposit
        ? `Deposit for ${service.name} at ${shop.name}`
        : `${service.name} at ${shop.name}`,
    });
    if (created) {
      payment = {
        clientSecret: created.clientSecret,
        // What we are ACTUALLY charging. The client used to label its button
        // from the full service price, which in deposit mode would read
        // "Pay $45" while taking $20.
        amountCents: chargeCents,
        isDeposit,
        // What they still owe at the shop; 0 when the whole ticket is paid.
        balanceDueCents: Math.max(0, (fullCents ?? 0) - chargeCents),
      };
    }
  }

  res.status(201).json({
    ok: true,
    manageToken,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    // true = it's a REQUEST awaiting approval (no confirmation yet); the client
    // renders "Request sent" instead of "You're booked".
    pending: shop.requireBookingApproval,
    // When present, the client must confirm payment with the Payment Element.
    payment,
  });
});

// SlotTakenError moved to engines/bookingWrite.ts (shared by every write site).

//  Manage by token (cancel / reschedule) - the token IS the authorization.

bookingPublicRouter.get("/manage/:token", rewardsLimiter, async (req, res) => {
  const appt = await prisma.appointment.findUnique({
    where: { manageToken: String(req.params.token) },
    select: {
      id: true,
      status: true,
      startsAt: true,
      endsAt: true,
      firstName: true,
      checkInStatus: true,
      etaMinutes: true,
      runningLate: true,
      shop: { select: { name: true, timezone: true, slug: true } },
      service: { select: { name: true, durationMin: true } },
      staff: { select: { name: true } },
    },
  });
  if (!appt) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const now = new Date();
  const canChange = appt.status === "BOOKED" && appt.startsAt > now;

  // The barber's "come early" nudges for THIS appointment, newest first, plus
  // whether the client already sent their one-tap reply. Shown as a banner with
  // "On my way" / "Can't make it early" buttons.
  const nudges =
    appt.status === "BOOKED"
      ? await prisma.nudge.findMany({
          where: {
            appointmentId: appt.id,
            kind: "checkin_nudge",
            status: { in: ["PENDING", "SENT", "FAILED"] },
          },
          orderBy: { createdAt: "desc" },
          take: 2,
          select: { body: true, createdAt: true },
        })
      : [];
  const replied =
    nudges.length === 0
      ? false
      : (await prisma.nudge.count({
          where: { appointmentId: appt.id, kind: "checkin_nudge_reply" },
        })) > 0;

  res.json({
    status: appt.status,
    firstName: appt.firstName,
    startsAt: appt.startsAt.toISOString(),
    endsAt: appt.endsAt.toISOString(),
    shop: appt.shop,
    service: appt.service,
    staff: appt.staff,
    canCancel: canChange,
    canReschedule: canChange,
    // Check-in ("On my way"): the window is computed HERE so the client needs
    // no timezone math - it just renders the button when open is true. A
    // received nudge opens the window early (the barber ASKED them to come).
    checkin: {
      open: checkInWindowOpen(appt.status, appt.startsAt, now, nudges.length > 0),
      status: appt.checkInStatus,
      etaMinutes: appt.etaMinutes,
      runningLate: appt.runningLate,
    },
    nudges: nudges.map((n) => ({
      body: n.body,
      sentAt: n.createdAt.toISOString(),
    })),
    nudgeReplied: replied,
  });
});

//  Check-in ("On my way") - push-only, never SMS.

/** Tap window: from 60 min before the start until 15 min after (grace). */
const CHECKIN_OPEN_BEFORE_MS = 60 * 60_000;
const CHECKIN_GRACE_AFTER_MS = 15 * 60_000;

/**
 * `nudged` widens the window: a barber "come early" nudge IS an invitation to
 * head over now, so a nudged client may check in any time before the grace
 * cutoff - not just inside the standard 60-min window.
 */
function checkInWindowOpen(
  status: string,
  startsAt: Date,
  now: Date,
  nudged = false,
): boolean {
  if (status !== "BOOKED") return false;
  if (now.getTime() > startsAt.getTime() + CHECKIN_GRACE_AFTER_MS) return false;
  if (nudged) return true;
  return now.getTime() >= startsAt.getTime() - CHECKIN_OPEN_BEFORE_MS;
}

// POST /api/book/manage/:token/checkin - the customer marks themselves en
// route. The manageToken scopes the write to exactly ONE appointment (a foreign
// token 404s like every other manage route), and the handler can only ever
// write 'en_route' - 'arrived' is the barber's dashboard action. One-way: a
// repeat tap may refresh the ETA chips but checkedInAt stays at the FIRST tap
// and there is no un-check-in.
const checkinSchema = z
  .object({
    etaMinutes: z
      .union([z.literal(5), z.literal(10), z.literal(15)])
      .optional(),
    runningLate: z.boolean().optional(),
  })
  .strict();

bookingPublicRouter.post(
  "/manage/:token/checkin",
  bookingWriteLimiter,
  async (req, res) => {
    const parsed = checkinSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const appt = await prisma.appointment.findUnique({
      where: { manageToken: String(req.params.token) },
      select: {
        id: true,
        shopId: true,
        status: true,
        startsAt: true,
        firstName: true,
        checkInStatus: true,
        checkedInAt: true,
        etaMinutes: true,
        runningLate: true,
        staff: { select: { userId: true } },
        shop: { select: { ownerId: true } },
      },
    });
    if (!appt) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const now = new Date();
    if (!checkInWindowOpen(appt.status, appt.startsAt, now)) {
      // A barber nudge opens the window early - re-check before rejecting.
      const nudged =
        (await prisma.nudge.count({
          where: { appointmentId: appt.id, kind: "checkin_nudge" },
        })) > 0;
      if (!checkInWindowOpen(appt.status, appt.startsAt, now, nudged)) {
        res.status(409).json({ error: "checkin_window_closed" });
        return;
      }
    }
    // 'arrived' is barber-set and final - the client can't regress it.
    if (appt.checkInStatus === "arrived") {
      res.status(409).json({ error: "already_arrived" });
      return;
    }

    const firstTap = appt.checkInStatus === null;
    const eta = parsed.data.etaMinutes ?? null;
    const late = parsed.data.runningLate ?? false;
    await prisma.appointment.update({
      where: { id: appt.id },
      data: {
        checkInStatus: "en_route",
        // Stamped once, on the first tap; ETA-chip re-taps never move it.
        ...(appt.checkedInAt ? {} : { checkedInAt: now }),
        etaMinutes: eta,
        runningLate: late,
      },
    });

    // Push the barber (the staff's linked user, else the owner) - push ONLY,
    // no SMS leg by design. Fires on the first tap and again whenever the ETA
    // chips add or CHANGE real information (5 min -> 15 min must re-notify, or
    // the barber keeps a stale ETA); the shared collapse tag makes each update
    // REPLACE the earlier notification instead of stacking a buzz-per-chip.
    const meaningfulUpdate =
      (eta !== null && eta !== appt.etaMinutes) ||
      (late && !appt.runningLate);
    if (firstTap || meaningfulUpdate) {
      const body = late
        ? "Running a little late"
        : eta
          ? `About ${eta} min out`
          : "Heads up - they tapped “On my way”";
      await sendPushToUser({
        userId: appt.staff.userId ?? appt.shop.ownerId,
        shopId: appt.shopId,
        payload: {
          title: `${appt.firstName} is on the way`,
          body,
          url: `${apiEnv().APP_BASE_URL}/dashboard/booking`,
          tag: `checkin-${appt.id}`,
        },
      }).catch((err) =>
        logger.error(
          { err, appointmentId: appt.id },
          "check-in barber push failed",
        ),
      );
    }

    res.json({ ok: true, status: "en_route" });
  },
);

// POST /api/book/manage/:token/nudge-reply - the client's one-tap answer to a
// barber "come early" nudge. "On my way" reuses /checkin; this endpoint carries
// the decline ("can't make it early") back to the barber as a push. Only valid
// while a nudge exists, and capped at one reply per nudge received (a spam
// guard - the button is one-tap, so a client could otherwise buzz the barber
// repeatedly).
const nudgeReplySchema = z
  .object({ reply: z.enum(["cant_make_it_early"]) })
  .strict();

bookingPublicRouter.post(
  "/manage/:token/nudge-reply",
  bookingWriteLimiter,
  async (req, res) => {
    const parsed = nudgeReplySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const appt = await prisma.appointment.findUnique({
      where: { manageToken: String(req.params.token) },
      select: {
        id: true,
        shopId: true,
        status: true,
        firstName: true,
        clientId: true,
        staff: { select: { userId: true } },
        shop: { select: { ownerId: true } },
      },
    });
    if (!appt) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (appt.status !== "BOOKED") {
      res.status(409).json({ error: "not_active" });
      return;
    }
    const [nudgeCount, replyCount] = await Promise.all([
      prisma.nudge.count({
        where: { appointmentId: appt.id, kind: "checkin_nudge" },
      }),
      prisma.nudge.count({
        where: { appointmentId: appt.id, kind: "checkin_nudge_reply" },
      }),
    ]);
    if (nudgeCount === 0) {
      res.status(409).json({ error: "no_nudge" });
      return;
    }
    if (replyCount >= nudgeCount) {
      res.status(429).json({ error: "already_replied" });
      return;
    }

    const body = `${appt.firstName}: can't make it early`;
    await prisma.nudge.create({
      data: {
        shopId: appt.shopId,
        clientId: appt.clientId!,
        appointmentId: appt.id,
        channel: "WEB_PUSH",
        kind: "checkin_nudge_reply",
        status: "SENT",
        body,
        sentAt: new Date(),
      },
    });
    await sendPushToUser({
      userId: appt.staff.userId ?? appt.shop.ownerId,
      shopId: appt.shopId,
      payload: {
        title: body,
        body: "They'll keep the original time.",
        url: `${apiEnv().APP_BASE_URL}/dashboard/booking`,
        tag: `nudge-reply-${appt.id}`,
      },
    }).catch((err) =>
      logger.error({ err, appointmentId: appt.id }, "nudge reply push failed"),
    );
    res.json({ ok: true });
  },
);

// POST /api/book/manage/:token/cancel - the customer cancels their own booking.
bookingPublicRouter.post(
  "/manage/:token/cancel",
  bookingWriteLimiter,
  async (req, res) => {
    const appt = await prisma.appointment.findUnique({
      where: { manageToken: String(req.params.token) },
      select: { id: true, shopId: true, status: true, startsAt: true },
    });
    if (!appt) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (appt.status !== "BOOKED" || appt.startsAt <= new Date()) {
      res.status(409).json({ error: "not_cancelable" });
      return;
    }
    // Customer-initiated: honor the shop's cancellation policy (a fee may apply
    // if they cancel inside the window). A paid booking is refunded accordingly.
    await cancelAppointment(appt.shopId, appt.id, "CANCELED", new Date(), {
      applyPolicyFee: true,
    });
    // Freed-up time is actionable (rebook it) - alert the barber (push + SMS).
    void notifyBarberBookingEvent({
      shopId: appt.shopId,
      appointmentId: appt.id,
      kind: "canceled",
    });
    invalidateShopAvailabilityCaches(appt.shopId);
    res.json({ ok: true });
  },
);

/**
 * GET /api/book/manage/:token/slots - the open times this booking could move
 * to, so the manage page can offer a real one-tap reschedule.
 *
 * The TOKEN is the authorization, exactly as for cancel/reschedule, which is
 * why this exists as its own route rather than the client calling the public
 * /slots feed: the appointment already knows its own staff and service, so
 * those ids never have to be handed to the browser.
 *
 * Its OWN slot is excluded from the busy set (excludeAppointmentId) - without
 * that, the time the customer currently holds reads as taken, and the one
 * appointment they are allowed to move looks like the one time they can't pick.
 */
bookingPublicRouter.get(
  "/manage/:token/slots",
  bookingReadLimiter,
  async (req, res) => {
    const appt = await prisma.appointment.findUnique({
      where: { manageToken: String(req.params.token) },
      select: {
        id: true,
        shopId: true,
        staffId: true,
        serviceId: true,
        status: true,
        startsAt: true,
        shop: { select: { timezone: true, bookingMaxDays: true } },
      },
    });
    if (!appt) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const now = new Date();
    // A canceled or past booking has nothing to move. Empty list rather than
    // an error: the page renders "no times available" without a failure state.
    if (appt.status !== "BOOKED" || appt.startsAt <= now) {
      res.json({ timezone: appt.shop.timezone, slots: [] });
      return;
    }
    // WINDOW, not the whole booking horizon. Sweeping all bookingMaxDays (45 by
    // default) returned ~960 slots on a normal 9-5 week - a payload nobody
    // reads and a picker nobody can scroll, where the last chip sat two months
    // out. Someone MOVING an appointment wants a nearby time, so offer the next
    // fortnight, extended a little past the booking itself when it is further
    // out than that (otherwise a customer booked 6 weeks ahead would be shown
    // only times in the next two weeks, nowhere near the date they care about).
    const DAY_MS = 24 * 60 * 60 * 1000;
    const horizon = Math.min(
      now.getTime() + appt.shop.bookingMaxDays * DAY_MS,
      Math.max(now.getTime() + 14 * DAY_MS, appt.startsAt.getTime() + 3 * DAY_MS),
    );
    const slots = await computeOpenSlots({
      shopId: appt.shopId,
      staffId: appt.staffId,
      serviceId: appt.serviceId,
      fromDate: now,
      toDate: new Date(horizon),
      now,
      excludeAppointmentId: appt.id,
    });
    res.json({
      timezone: appt.shop.timezone,
      slots: slots.map((s) => ({ startsAt: s.startsAt.toISOString() })),
    });
  },
);

// POST /api/book/manage/:token/reschedule - move a booking to a new open slot.
const rescheduleSchema = z.object({ startsAt: validDate }).strict();

bookingPublicRouter.post(
  "/manage/:token/reschedule",
  bookingWriteLimiter,
  async (req, res) => {
    const parsed = rescheduleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const appt = await prisma.appointment.findUnique({
      where: { manageToken: String(req.params.token) },
      select: {
        id: true,
        shopId: true,
        staffId: true,
        serviceId: true,
        status: true,
        startsAt: true,
        payment: { select: { status: true, amount: true } },
        service: {
          select: {
            durationMin: true,
            durationOverrides: true,
            timeOverrides: true,
            price: true,
            priceOverrides: true,
        dateOverrides: true,
          },
        },
        shop: {
          select: {
            timezone: true,
            bookingLeadHours: true,
            bookingMaxDays: true,
            bookingBufferMin: true,
            bookingMode: true,
            publicPageEnabled: true,
            subscriptionStatus: true,
            trialEndsAt: true,
            compAccess: true,
          },
        },
      },
    });
    if (!appt || appt.shop.bookingMode !== "native" || !appt.shop.publicPageEnabled) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // A lapsed shop can't churn its calendar either (mirror the create gate).
    if (!hasActiveAccess(appt.shop)) {
      res.status(403).json({ error: "no_active_access" });
      return;
    }
    if (appt.status !== "BOOKED" || appt.startsAt <= new Date()) {
      res.status(409).json({ error: "not_reschedulable" });
      return;
    }

    const now = new Date();
    const startsAt = parsed.data.startsAt;
    // The new slot may fall on a different-duration weekday OR inside a
    // time-of-day window - re-measure, like the reprice below. (Add-on minutes
    // aren't carried through a reschedule today - endsAt was already
    // service-only on this path.)
    const endsAt = new Date(
      startsAt.getTime() +
        effectiveDurationAt(appt.service.durationMin, {
          at: startsAt,
          timezone: appt.shop.timezone,
          weekdayOverrides: appt.service.durationOverrides,
          timeWindows: appt.service.timeOverrides,
        }) *
          60_000,
    );
    // The new slot may carry a different date/window/weekday price - reprice.
    const effectivePrice = effectivePriceAt(
      appt.service.price === null ? null : Number(appt.service.price),
      {
        at: startsAt,
        timezone: appt.shop.timezone,
        weekdayOverrides: appt.service.priceOverrides,
        dateOverrides: appt.service.dateOverrides,
        timeWindows: appt.service.timeOverrides,
      },
    );
    const earliest = now.getTime() + appt.shop.bookingLeadHours * 60 * 60_000;
    const latest = now.getTime() + appt.shop.bookingMaxDays * 24 * 60 * 60_000;
    if (startsAt.getTime() < earliest) {
      res.status(400).json({ error: "too_soon" });
      return;
    }
    if (startsAt.getTime() > latest) {
      res.status(400).json({ error: "too_far" });
      return;
    }

    // If the booking is already PAID and the new date costs a different amount,
    // a self-serve reschedule can't reconcile the captured charge in v1 (no
    // partial capture/top-up here). Block it and point the customer at the shop,
    // rather than silently leaving them over/under-charged.
    const paidAmount =
      appt.payment && appt.payment.status === "succeeded" ? appt.payment.amount : null;
    if (paidAmount !== null) {
      const newCents = toCents(effectivePrice);
      if (newCents !== null && newCents !== paidAmount) {
        res.status(409).json({ error: "price_changed", message: "That day has a different price. Please contact the shop to move a paid booking." });
        return;
      }
    }

    // Re-validate the new time against availability (excluding this appointment's
    // own current slot), same authoritative check as create.
    if (
      !(await isSlotBookable({
        shopId: appt.shopId,
        staffId: appt.staffId,
        serviceId: appt.serviceId,
        startsAt,
        excludeAppointmentId: appt.id,
      }))
    ) {
      res.status(400).json({ error: "invalid_slot" });
      return;
    }

    try {
      await prisma.$transaction(async (tx) => {
        // Same shared guard as create, EXCLUDING this appt's own row.
        await lockStaffAndAssertSlotFree(tx, {
          staffId: appt.staffId,
          shopId: appt.shopId,
          startsAt,
          endsAt,
          bufferMin: appt.shop.bookingBufferMin,
          excludeAppointmentId: appt.id,
          // Moving INTO a day counts against that day. Its own row is
          // excluded, so moving within the same day is always allowed even
          // when that day is at the cap.
          serviceDayLimit: {
            serviceId: appt.serviceId,
            timezone: appt.shop.timezone,
          },
        });
        // Move it, reprice for the new date, and reset send-state so a fresh
        // confirmation/reminder go out - the PUSH reminder stamps too, or the
        // moved appointment would silently never get its 24h/2h push. Check-in
        // state is likewise cleared: an "en route" tapped for the OLD time is
        // meaningless for the new one (and would pin a stale pill days out).
        await tx.appointment.update({
          where: { id: appt.id },
          data: {
            startsAt,
            endsAt,
            priceAtBooking: effectivePrice ?? null,
            confirmationSentAt: null,
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
      if (err instanceof ServiceDayFullError) {
        res.status(409).json({ error: "day_full" });
        return;
      }
      if (
        err instanceof SlotTakenError ||
        (err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002")
      ) {
        res.status(409).json({ error: "slot_taken" });
        return;
      }
      logger.error({ err, appointmentId: appt.id }, "reschedule failed");
      res.status(500).json({ error: "reschedule_failed" });
      return;
    }

    void notifyAppointmentConfirmation({
      shopId: appt.shopId,
      appointmentId: appt.id,
    });
    // The barber's day just changed under them - mirror alert (push + SMS).
    void notifyBarberBookingEvent({
      shopId: appt.shopId,
      appointmentId: appt.id,
      kind: "rescheduled",
    });
    invalidateShopAvailabilityCaches(appt.shopId);
    res.json({ ok: true, startsAt: startsAt.toISOString() });
  },
);
