import { Router } from "express";
import { z } from "zod";
import { prisma, runWithShop } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireManager } from "../auth/roles.js";
import { openMinutesForDay, shopLocalDays } from "../engines/utilization.js";

/**
 * Shop insights: the barber's own analytics page. Everything is derived from
 * data that already exists (Visits, PunchLedger) - no new tables, no counters
 * to keep in sync. One endpoint returns the whole page:
 *
 *   - weekly completed-visit + revenue series (Mon-start weeks, SHOP timezone)
 *   - top services by count and revenue (from Visit.serviceName; Square visits
 *     have no service name and land in the "(no service)" bucket honestly)
 *   - totals: visits, revenue + avg ticket (PRICED visits only - unpriced
 *     manual visits don't drag the average to zero), unique/new/returning
 *   - busiest weekday
 *   - loyalty activity (punches earned/redeemed, standing redemptions)
 *
 * Revenue is real summed Visit.price, never an estimate; anything unpriced
 * simply contributes 0 revenue but still counts as a visit.
 */
export const insightsRouter: Router = Router();
insightsRouter.use(requireUser, requireShop, requireManager);

const WEEK_CHOICES = [8, 12, 26] as const;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

// Constructing an Intl.DateTimeFormat is expensive (loads ICU data); shopLocalDay
// is called once per visit AND once per groupBy row, so a busy shop over 26 weeks
// would build thousands of formatters and stall the single Node thread. Cache one
// formatter per timezone (a handful of distinct zones across all shops).
const dayFormatterCache = new Map<string, Intl.DateTimeFormat>();
function dayFormatter(timezone: string): Intl.DateTimeFormat {
  let fmt = dayFormatterCache.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormatterCache.set(timezone, fmt);
  }
  return fmt;
}

/**
 * A visit's calendar day in the shop's timezone. en-CA formats as YYYY-MM-DD,
 * which we reinterpret as a UTC date for stable week math. Weeks must bucket in
 * shop-local time: a Friday 11pm cut in New York is Saturday in UTC, and
 * "cuts per week" that shifts late appointments into the wrong week reads
 * wrong to the barber.
 */
function shopLocalDay(d: Date, timezone: string): Date {
  const ymd = dayFormatter(timezone).format(d);
  return new Date(`${ymd}T00:00:00Z`);
}

/** Monday 00:00 of the week containing `day` (day is already a UTC-midnight date). */
function weekStart(day: Date): Date {
  const dow = (day.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  return new Date(day.getTime() - dow * DAY_MS);
}

insightsRouter.get("/", async (req, res) => {
  const shop = req.shop!;
  const requested = Number(req.query.weeks ?? 12);
  const weekCount = (WEEK_CHOICES as readonly number[]).includes(requested)
    ? requested
    : 12;

  const now = new Date();
  const thisWeek = weekStart(shopLocalDay(now, shop.timezone));
  const windowStart = new Date(thisWeek.getTime() - (weekCount - 1) * 7 * DAY_MS);
  // The DB filter needs a real instant; pad a day so timezone offsets can never
  // clip a visit that's inside the window shop-locally.
  const fetchFrom = new Date(windowStart.getTime() - DAY_MS);

  const [visits, ledgerAgg, redemptions] = await Promise.all([
    prisma.visit.findMany({
      where: { shopId: shop.id, status: "COMPLETED", scheduledAt: { gte: fetchFrom } },
      select: { scheduledAt: true, serviceName: true, price: true, clientId: true },
    }),
    prisma.punchLedger.aggregate({
      // Standing activity only: exclude a reversed original (reversedAt set) AND
      // its offsetting correction (reversalOfId set), so a punch-and-undo pair
      // nets to 0/0 instead of showing "1 earned, 1 redeemed". A regrant from an
      // "edit count" (correctionOfId set, reversalOfId null) is a REAL earn and
      // stays included - mirrors the redemptions predicate just below.
      where: {
        shopId: shop.id,
        createdAt: { gte: windowStart },
        reversedAt: null,
        reversalOfId: null,
      },
      _sum: { punchesEarned: true, punchesRedeemed: true },
    }),
    // Standing redemptions (same predicate as the loyalty designer's
    // timesRedeemed): real redemptions, not undone, not correction rows.
    prisma.punchLedger.count({
      where: {
        shopId: shop.id,
        createdAt: { gte: windowStart },
        punchesRedeemed: { gt: 0 },
        reversedAt: null,
        reversalOfId: null,
      },
    }),
  ]);

  // Bucket visits into shop-local weeks; drop the timezone-padding stragglers.
  const weeks = Array.from({ length: weekCount }, (_, i) => {
    const start = new Date(windowStart.getTime() + i * 7 * DAY_MS);
    return {
      start,
      label: start.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
      visits: 0,
      revenue: 0,
    };
  });
  const byService = new Map<string, { count: number; revenue: number }>();
  const dayCounts = [0, 0, 0, 0, 0, 0, 0]; // Mon..Sun
  const clientIds = new Set<string>();
  let pricedRevenue = 0;
  let pricedCount = 0;
  let inWindow = 0;

  for (const v of visits) {
    const day = shopLocalDay(v.scheduledAt, shop.timezone);
    const start = weekStart(day);
    const index = Math.round((start.getTime() - windowStart.getTime()) / (7 * DAY_MS));
    if (index < 0 || index >= weekCount) continue; // fetch padding, not the window
    inWindow++;
    const price = v.price === null ? 0 : Number(v.price);
    const week = weeks[index]!;
    week.visits++;
    week.revenue += price;
    dayCounts[(day.getUTCDay() + 6) % 7]!++;
    clientIds.add(v.clientId);
    if (v.price !== null) {
      pricedRevenue += price;
      pricedCount++;
    }
    const service = v.serviceName?.trim() || "(no service)";
    const s = byService.get(service) ?? { count: 0, revenue: 0 };
    s.count++;
    s.revenue += price;
    byService.set(service, s);
  }

  // New vs returning: a client is NEW in this window when their first-ever
  // completed visit falls inside it. One indexed groupBy over the window's
  // clients only.
  let newClients = 0;
  if (clientIds.size > 0) {
    const firstVisits = await prisma.visit.groupBy({
      by: ["clientId"],
      where: {
        shopId: shop.id,
        status: "COMPLETED",
        clientId: { in: [...clientIds] },
      },
      _min: { scheduledAt: true },
    });
    for (const f of firstVisits) {
      const first = f._min.scheduledAt;
      if (first && weekStart(shopLocalDay(first, shop.timezone)) >= windowStart) {
        newClients++;
      }
    }
  }

  const services = [...byService.entries()]
    .map(([name, s]) => ({
      name,
      count: s.count,
      revenue: Math.round(s.revenue),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const busiestIndex = dayCounts.some((c) => c > 0)
    ? dayCounts.indexOf(Math.max(...dayCounts))
    : -1;

  res.json({
    weeks: weeks.map((w) => ({
      label: w.label,
      visits: w.visits,
      revenue: Math.round(w.revenue),
    })),
    services,
    totals: {
      visits: inWindow,
      revenue: Math.round(pricedRevenue),
      // Priced visits only: an unpriced walk-in shouldn't read as a $0 ticket.
      avgTicket: pricedCount > 0 ? Math.round(pricedRevenue / pricedCount) : 0,
      uniqueClients: clientIds.size,
      newClients,
      returningClients: clientIds.size - newClients,
    },
    busiest: {
      weekday: busiestIndex >= 0 ? WEEKDAYS[busiestIndex] : null,
      counts: dayCounts,
    },
    loyalty: {
      punchesEarned: ledgerAgg._sum.punchesEarned ?? 0,
      punchesRedeemed: ledgerAgg._sum.punchesRedeemed ?? 0,
      redemptions,
    },
  });
});

//  Chair utilization: open time vs sold time

/**
 * GET /api/insights/utilization?weeks=8|12|26&by=weekday|service&staffId=…
 *
 * "Busiest day" counts bookings; this measures how much of the time the shop
 * was OPEN actually got sold. Four bookings on a full Saturday and four on a
 * barely-worked Wednesday look identical in a count and completely different
 * here — which is the number that tells a barber where the empty hours are.
 *
 * `by=weekday` gives capacity vs booked per weekday (the utilization view).
 * `by=service` splits the SAME booked time by what filled it — capacity is not
 * per-service (services share one chair), so a service row reports its share
 * of booked time and of total open time rather than its own utilization.
 *
 * Booked time counts native appointments AND external synced (Acuity/Square)
 * visits: both really occupied the chair. Canceled time is excluded (it was
 * given back); a no-show is included (nobody else could book that hour).
 *
 * Only days up to TODAY are measured — future days have capacity but no
 * settled outcome, and averaging them in would drag every number toward zero.
 */
const utilizationQuerySchema = z.object({
  weeks: z.coerce.number().int().optional(),
  by: z.enum(["weekday", "service"]).optional(),
  staffId: z.string().min(1).optional(),
});

insightsRouter.get("/utilization", async (req, res) => {
  const shop = req.shop!;
  const parsed = utilizationQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const weekCount = (WEEK_CHOICES as readonly number[]).includes(parsed.data.weeks ?? 12)
    ? (parsed.data.weeks ?? 12)
    : 12;
  const by = parsed.data.by ?? "weekday";

  const now = new Date();
  const thisWeek = weekStart(shopLocalDay(now, shop.timezone));
  const windowStart = new Date(thisWeek.getTime() - (weekCount - 1) * 7 * DAY_MS);
  // Measure through the END of yesterday: today is still in progress, and a
  // half-finished day would read as a slump every time the barber checks
  // before lunch.
  const today = shopLocalDay(now, shop.timezone);
  const lastMeasuredDay = new Date(today.getTime() - DAY_MS);
  if (lastMeasuredDay < windowStart) {
    res.json({
      by,
      weeks: weekCount,
      timezone: shop.timezone,
      staff: [],
      rows: [],
      totals: { openMin: 0, bookedMin: 0, bookings: 0, utilizationPct: null },
      scheduleCaveat: false,
    });
    return;
  }

  // Concrete UTC bounds for the DB reads (pad a day so a shop-local day whose
  // instants straddle UTC midnight can't be clipped).
  const fetchFrom = new Date(windowStart.getTime() - DAY_MS);
  const fetchTo = new Date(lastMeasuredDay.getTime() + 2 * DAY_MS);

  const staffFilter = parsed.data.staffId;
  const [staffRows, rules, recurringBlocks, exceptions, appts, visits] = await Promise.all([
    prisma.staff.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true },
    }),
    prisma.availabilityRule.findMany({
      where: { shopId: shop.id, ...(staffFilter ? { staffId: staffFilter } : {}) },
      select: { staffId: true, weekday: true, startMin: true, endMin: true },
    }),
    prisma.recurringBlock.findMany({
      where: { shopId: shop.id, ...(staffFilter ? { staffId: staffFilter } : {}) },
      select: { staffId: true, weekday: true, startMin: true, endMin: true },
    }),
    prisma.availabilityException.findMany({
      where: {
        shopId: shop.id,
        ...(staffFilter ? { staffId: staffFilter } : {}),
        startsAt: { lt: fetchTo },
        endsAt: { gt: fetchFrom },
      },
      select: { staffId: true, startsAt: true, endsAt: true, isBlock: true },
    }),
    // Native bookings that occupied the chair. Holds (PENDING with an expiry)
    // are provisional, never sold time.
    prisma.appointment.findMany({
      where: {
        shopId: shop.id,
        ...(staffFilter ? { staffId: staffFilter } : {}),
        holdExpiresAt: null,
        status: { in: ["BOOKED", "COMPLETED", "NO_SHOW"] },
        startsAt: { gte: fetchFrom, lt: fetchTo },
      },
      select: {
        startsAt: true,
        endsAt: true,
        service: { select: { name: true } },
      },
    }),
    // External synced bookings (Acuity/Square). `appointment: null` keeps a
    // visit promoted from a native appointment from double-counting its time.
    // Not staff-filterable: a Visit carries no staffId.
    prisma.visit.findMany({
      where: {
        shopId: shop.id,
        appointment: null,
        status: { in: ["SCHEDULED", "RESCHEDULED", "COMPLETED", "NO_SHOW"] },
        scheduledAt: { gte: fetchFrom, lt: fetchTo },
      },
      select: { scheduledAt: true, endAt: true, serviceName: true },
    }),
  ]);

  const staffIds = staffFilter
    ? staffRows.filter((s) => s.id === staffFilter).map((s) => s.id)
    : staffRows.map((s) => s.id);

  // --- Capacity per weekday, from the schedule ---
  const days = shopLocalDays(windowStart, lastMeasuredDay, shop.timezone);
  const openByWeekday = new Array(7).fill(0) as number[];
  const daysByWeekday = new Array(7).fill(0) as number[];
  for (const d of days) {
    openByWeekday[d.weekday] =
      (openByWeekday[d.weekday] ?? 0) +
      openMinutesForDay({
        dayStartUtc: d.dayStartUtc,
        weekday: d.weekday,
        staffIds,
        rules,
        recurringBlocks,
        exceptions,
      });
    daysByWeekday[d.weekday] = (daysByWeekday[d.weekday] ?? 0) + 1;
  }

  // --- Booked time, bucketed the same way ---
  const bookedByWeekday = new Array(7).fill(0) as number[];
  const countByWeekday = new Array(7).fill(0) as number[];
  const byService = new Map<string, { min: number; count: number }>();
  const DEFAULT_MIN = 30; // a visit with no recorded end still held the chair

  const addBooking = (start: Date, end: Date | null, serviceName: string | null) => {
    const local = shopLocalDay(start, shop.timezone);
    if (local < windowStart || local > lastMeasuredDay) return;
    const minutes =
      end && end > start
        ? Math.round((end.getTime() - start.getTime()) / 60_000)
        : DEFAULT_MIN;
    // JS getUTCDay on a UTC-midnight shop-local day == the shop-local weekday.
    const weekday = local.getUTCDay();
    bookedByWeekday[weekday] = (bookedByWeekday[weekday] ?? 0) + minutes;
    countByWeekday[weekday] = (countByWeekday[weekday] ?? 0) + 1;
    const key = serviceName?.trim() || "(no service)";
    const s = byService.get(key) ?? { min: 0, count: 0 };
    s.min += minutes;
    s.count += 1;
    byService.set(key, s);
  };

  for (const a of appts) addBooking(a.startsAt, a.endsAt, a.service?.name ?? null);
  // Staff-filtered views drop external visits: a Visit has no staff, so
  // attributing its time to the selected barber would invent capacity usage.
  if (!staffFilter) {
    for (const v of visits) addBooking(v.scheduledAt, v.endAt, v.serviceName);
  }

  const totalOpen = openByWeekday.reduce((a, b) => a + b, 0);
  const totalBooked = bookedByWeekday.reduce((a, b) => a + b, 0);
  const totalCount = countByWeekday.reduce((a, b) => a + b, 0);
  const pct = (booked: number, open: number): number | null =>
    open > 0 ? Math.round((booked / open) * 100) : null;

  // WEEKDAYS is Mon-first (matches the existing chart); JS weekday is Sun=0.
  const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];

  const rows =
    by === "weekday"
      ? MON_FIRST.map((jsDay, i) => ({
          key: WEEKDAYS[i]!,
          label: WEEKDAYS[i]!,
          openMin: openByWeekday[jsDay]!,
          bookedMin: bookedByWeekday[jsDay]!,
          bookings: countByWeekday[jsDay]!,
          days: daysByWeekday[jsDay]!,
          utilizationPct: pct(bookedByWeekday[jsDay]!, openByWeekday[jsDay]!),
        }))
      : [...byService.entries()]
          .sort((a, b) => b[1].min - a[1].min)
          .slice(0, 10)
          .map(([name, s]) => ({
            key: name,
            label: name,
            // Capacity is shared across services, so a service row reports the
            // slice of open time it filled — not a utilization of its own.
            openMin: 0,
            bookedMin: s.min,
            bookings: s.count,
            days: 0,
            utilizationPct: pct(s.min, totalOpen),
          }));

  res.json({
    by,
    weeks: weekCount,
    timezone: shop.timezone,
    staff: staffRows,
    staffId: staffFilter ?? null,
    rows,
    totals: {
      openMin: totalOpen,
      bookedMin: totalBooked,
      bookings: totalCount,
      utilizationPct: pct(totalBooked, totalOpen),
    },
    // True when the shop has no weekly hours at all: capacity is unknowable, so
    // the UI shows booked time only instead of a meaningless 0% / ∞.
    noSchedule: totalOpen === 0,
    // Capacity comes from the CURRENT weekly schedule; older days in the window
    // are measured against it. The UI says so rather than implying we kept
    // historical hours.
    scheduleCaveat: true,
  });
});

//  Quota goal ("$4,000 this month" / "60 cuts this week")

// Progress is derived from COMPLETED Visits — the SAME source as the totals
// above, so it reads identically for native and Acuity/Square-synced shops,
// and an unpriced walk-in counts as a visit but contributes $0 revenue.

/** Shop-local period window as UTC-midnight dates: [start, end). */
function periodWindow(
  now: Date,
  timezone: string,
  period: "week" | "month",
): { start: Date; end: Date } {
  const today = shopLocalDay(now, timezone);
  if (period === "week") {
    const start = weekStart(today);
    return { start, end: new Date(start.getTime() + 7 * DAY_MS) };
  }
  const start = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
  );
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  return { start, end };
}

// GET /api/insights/goal — the goal (or null) + live progress for the current
// period: actual, where the target's straight-line pace says they should be,
// and a per-day cumulative series for the chart.
insightsRouter.get("/goal", async (req, res) => {
  const shop = req.shop!;
  const goal = await runWithShop(shop.id, (tx) =>
    tx.shopGoal.findUnique({
      where: { shopId: shop.id },
      select: { metric: true, period: true, target: true },
    }),
  );
  if (!goal) {
    res.json({ goal: null, progress: null });
    return;
  }

  const now = new Date();
  const { start, end } = periodWindow(now, shop.timezone, goal.period);
  // Pad the DB filter a day each side so timezone offsets can't clip a visit
  // that's inside the window shop-locally (same trick as the weekly series).
  const visits = await prisma.visit.findMany({
    where: {
      shopId: shop.id,
      status: "COMPLETED",
      scheduledAt: {
        gte: new Date(start.getTime() - DAY_MS),
        lt: new Date(end.getTime() + DAY_MS),
      },
    },
    select: { scheduledAt: true, price: true },
  });

  const totalDays = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  const today = shopLocalDay(now, shop.timezone);
  // Day 1 = the period's first day. Clamp: a goal viewed outside its own
  // period (should not happen) still yields sane math.
  const elapsedDays = Math.min(
    totalDays,
    Math.max(1, Math.round((today.getTime() - start.getTime()) / DAY_MS) + 1),
  );

  // Per-day buckets across the whole period (future days stay 0 for the chart).
  const perDay = new Array<number>(totalDays).fill(0);
  let actual = 0;
  for (const v of visits) {
    const day = shopLocalDay(v.scheduledAt, shop.timezone);
    const idx = Math.round((day.getTime() - start.getTime()) / DAY_MS);
    if (idx < 0 || idx >= totalDays) continue; // padding stragglers
    const amount = goal.metric === "revenue" ? Number(v.price ?? 0) : 1;
    perDay[idx]! += amount;
    actual += amount;
  }
  let running = 0;
  const series = perDay.map((amount, i) => {
    // Cumulative up to today; future days carry null so the chart's actual
    // line stops at "now" instead of flatlining to the period's end.
    if (i >= elapsedDays) return { day: i + 1, cumulative: null };
    running += amount;
    return { day: i + 1, cumulative: Math.round(running) };
  });

  const paceTarget = (goal.target * elapsedDays) / totalDays;
  res.json({
    goal,
    progress: {
      periodStart: start.toISOString().slice(0, 10),
      periodEnd: new Date(end.getTime() - DAY_MS).toISOString().slice(0, 10),
      totalDays,
      elapsedDays,
      daysLeft: totalDays - elapsedDays,
      actual: Math.round(actual),
      paceTarget: Math.round(paceTarget),
      // ahead / behind by how much, vs the straight-line pace.
      delta: Math.round(actual - paceTarget),
      pct: goal.target > 0 ? Math.min(1, actual / goal.target) : 0,
      series,
    },
  });
});

const goalSchema = z
  .object({
    metric: z.enum(["revenue", "visits"]),
    period: z.enum(["week", "month"]),
    // Whole dollars or visit count. Upper bound is a sanity rail, not a limit
    // anyone real will hit.
    target: z.number().int().min(1).max(1_000_000),
  })
  .strict();

// PUT /api/insights/goal — set or replace the shop's one goal in place.
insightsRouter.put("/goal", async (req, res) => {
  const shop = req.shop!;
  const parsed = goalSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  await runWithShop(shop.id, (tx) =>
    tx.shopGoal.upsert({
      where: { shopId: shop.id },
      create: { shopId: shop.id, ...d },
      update: d,
    }),
  );
  res.json({ ok: true });
});

// DELETE /api/insights/goal — clear it (deleteMany: idempotent, no 404 dance).
insightsRouter.delete("/goal", async (req, res) => {
  const shop = req.shop!;
  await runWithShop(shop.id, (tx) =>
    tx.shopGoal.deleteMany({ where: { shopId: shop.id } }),
  );
  res.json({ ok: true });
});
