import { Router } from "express";
import { z } from "zod";
import { prisma, runWithShop } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireManager } from "../auth/roles.js";
import { openMinutesForDay, shopLocalDays } from "../engines/utilization.js";
import {
  DAY_MS,
  PERIODS,
  PERIOD_KEYS,
  WEEKDAYS,
  bucketIndexFor,
  localMidnightInstant,
  minutesIntoLocalDay,
  readChairEvents,
  resolvePeriod,
  resolvePeriodWindow,
  serviceKey,
  serviceLabel,
  shopLocalDay,
  weekStart,
  type ChairEvent,
  type PeriodKey,
} from "../engines/insightsWindow.js";

/**
 * Shop insights: the barber's own analytics page.
 *
 * ONE period control drives the whole page, and ONE definition of "a cut" feeds
 * every card - see engines/insightsWindow.ts for why (the page used to count
 * COMPLETED Visits at the top and Appointments in Chair time, so a native shop
 * saw a full Chair time card above an empty chart).
 *
 * Everything is still derived from data that already exists - no new tables, no
 * counters to keep in sync:
 *
 *   - a bucketed cuts + revenue series (daily / weekly / monthly, SHOP timezone)
 *   - services by bookings and by revenue, INCLUDING the shop's services that
 *     went unbooked in the window (a zero is a finding, not an omission)
 *   - totals: cuts, revenue + avg ticket (PRICED bookings only - unpriced
 *     walk-ins don't drag the average to zero), unique/new/returning clients
 *   - busiest weekday
 *   - loyalty activity (punches earned/redeemed, standing redemptions)
 *
 * Revenue is real summed price (Appointment.priceAtBooking / Visit.price), never
 * an estimate; anything unpriced contributes 0 revenue but still counts as a cut.
 */
export const insightsRouter: Router = Router();
insightsRouter.use(requireUser, requireShop, requireManager);

/** Every response echoes the window it measured, so no label can drift from it. */
function periodMeta(p: ReturnType<typeof resolvePeriodWindow>) {
  return {
    period: p.key,
    periodLabel: p.label,
    bucket: p.bucket,
    bucketNoun: p.noun,
    windowStart: p.windowStart.toISOString().slice(0, 10),
    windowEnd: p.today.toISOString().slice(0, 10),
    periods: PERIOD_KEYS.map((k) => ({ key: k, label: PERIODS[k].label })),
  };
}

insightsRouter.get("/", async (req, res) => {
  const shop = req.shop!;
  const now = new Date();
  const period = resolvePeriodWindow(now, shop.timezone, resolvePeriod(req.query.period));

  // The DB filter needs real instants. Pad a day each side so a shop-local day
  // whose instants straddle UTC midnight can never be clipped; events outside
  // the window are dropped by the shop-local bucket check below.
  const fetchFrom = new Date(period.windowStart.getTime() - DAY_MS);
  const fetchTo = new Date(period.today.getTime() + 2 * DAY_MS);

  const [{ events }, ledgerAgg, redemptions, shopServices] = await Promise.all([
    readChairEvents(shop.id, fetchFrom, fetchTo),
    prisma.punchLedger.aggregate({
      // Standing activity only: exclude a reversed original (reversedAt set) AND
      // its offsetting correction (reversalOfId set), so a punch-and-undo pair
      // nets to 0/0 instead of showing "1 earned, 1 redeemed". A regrant from an
      // "edit count" (correctionOfId set, reversalOfId null) is a REAL earn and
      // stays included - mirrors the redemptions predicate just below.
      where: {
        shopId: shop.id,
        createdAt: { gte: period.windowStart },
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
        createdAt: { gte: period.windowStart },
        punchesRedeemed: { gt: 0 },
        reversedAt: null,
        reversalOfId: null,
      },
    }),
    // The live menu, so a service nobody booked can still be listed at 0 rather
    // than silently missing - "where did my service go?" is the complaint that
    // an omission-only list produces.
    prisma.service.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true },
    }),
  ]);

  const buckets = period.buckets.map((b) => ({
    key: b.key,
    label: b.label,
    fullLabel: b.fullLabel,
    cuts: 0,
    revenue: 0,
  }));
  const byService = new Map<
    string,
    { serviceId: string | null; name: string; count: number; revenue: number }
  >();
  const dayCounts = [0, 0, 0, 0, 0, 0, 0]; // Mon..Sun
  const clientIds = new Set<string>();
  let pricedRevenue = 0;
  let pricedCount = 0;
  let totalRevenue = 0;
  let inWindow = 0;
  let walkIns = 0; // counted as cuts, but not attributable to a client

  for (const e of events) {
    // A booking in the future hasn't happened yet: it must not inflate "cuts",
    // and it must not appear as revenue already earned.
    if (e.start > now) continue;
    const day = shopLocalDay(e.start, shop.timezone);
    const index = bucketIndexFor(period, day);
    if (index < 0) continue; // fetch padding, not the window

    inWindow++;
    const price = e.price ?? 0;
    const bucket = buckets[index]!;
    bucket.cuts++;
    bucket.revenue += price;
    dayCounts[(day.getUTCDay() + 6) % 7]!++;
    totalRevenue += price;
    if (e.clientId) clientIds.add(e.clientId);
    else walkIns++;
    if (e.price !== null) {
      pricedRevenue += price;
      pricedCount++;
    }

    const key = serviceKey(e);
    const s = byService.get(key) ?? {
      serviceId: e.serviceId,
      name: serviceLabel(e),
      count: 0,
      revenue: 0,
    };
    s.count++;
    s.revenue += price;
    byService.set(key, s);
  }

  // New vs returning: a client is NEW in this window when their first-ever
  // booking with this shop falls inside it. Both systems are consulted - a
  // client whose first visit was on Acuity is not "new" because his first NATIVE
  // booking happens to be this week.
  let newClients = 0;
  if (clientIds.size > 0) {
    const ids = [...clientIds];
    const [firstVisits, firstAppts] = await Promise.all([
      prisma.visit.groupBy({
        by: ["clientId"],
        where: {
          shopId: shop.id,
          status: { in: ["SCHEDULED", "RESCHEDULED", "COMPLETED", "NO_SHOW"] },
          clientId: { in: ids },
        },
        _min: { scheduledAt: true },
      }),
      prisma.appointment.groupBy({
        by: ["clientId"],
        where: {
          shopId: shop.id,
          holdExpiresAt: null,
          status: { in: ["BOOKED", "COMPLETED", "NO_SHOW"] },
          clientId: { in: ids },
        },
        _min: { startsAt: true },
      }),
    ]);
    const firstEver = new Map<string, Date>();
    const note = (clientId: string | null, at: Date | null) => {
      if (!clientId || !at) return;
      const prev = firstEver.get(clientId);
      if (!prev || at < prev) firstEver.set(clientId, at);
    };
    for (const f of firstVisits) note(f.clientId, f._min.scheduledAt);
    for (const f of firstAppts) note(f.clientId, f._min.startsAt);
    for (const at of firstEver.values()) {
      if (shopLocalDay(at, shop.timezone) >= period.windowStart) newClients++;
    }
  }

  // Booked services first (by count), then the untouched menu at 0 so the list
  // is the whole menu, not a truncated top-8.
  const booked = [...byService.values()].sort(
    (a, b) => b.count - a.count || b.revenue - a.revenue,
  );
  const bookedServiceIds = new Set(
    booked.map((s) => s.serviceId).filter((id): id is string => id !== null),
  );
  const bookedNames = new Set(booked.map((s) => s.name.trim().toLowerCase()));
  const unbooked = shopServices
    .filter(
      (s) => !bookedServiceIds.has(s.id) && !bookedNames.has(s.name.trim().toLowerCase()),
    )
    .map((s) => ({ serviceId: s.id, name: s.name, count: 0, revenue: 0 }));

  const services = [...booked, ...unbooked].map((s) => ({
    serviceId: s.serviceId,
    name: s.name,
    count: s.count,
    revenue: Math.round(s.revenue),
  }));

  const busiestIndex = dayCounts.some((c) => c > 0)
    ? dayCounts.indexOf(Math.max(...dayCounts))
    : -1;

  res.json({
    ...periodMeta(period),
    buckets,
    services,
    totals: {
      visits: inWindow,
      revenue: Math.round(totalRevenue),
      // Priced bookings only: an unpriced walk-in shouldn't read as a $0 ticket.
      avgTicket: pricedCount > 0 ? Math.round(pricedRevenue / pricedCount) : 0,
      pricedCount,
      unpricedCount: inWindow - pricedCount,
      uniqueClients: clientIds.size,
      newClients,
      returningClients: clientIds.size - newClients,
      // Bookings taken without a client record. They are real cuts and real
      // revenue, but they cannot be counted as a person - saying so keeps
      // "cuts" and "clients seen" from looking like a contradiction.
      walkIns,
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
 * GET /api/insights/utilization?period=…&by=weekday|period|service&staffId=…
 *
 * "Busiest day" counts bookings; this measures how much of the time the shop was
 * OPEN actually got sold. Four bookings on a full Saturday and four on a
 * barely-worked Wednesday look identical in a count and completely different
 * here - which is the number that tells a barber where the empty hours are.
 *
 *   by=weekday  capacity vs booked per weekday - "which DAY runs empty?"
 *   by=period   the same measure over time (daily/weekly/monthly, following the
 *               page's period control) - "am I getting fuller or emptier?"
 *   by=service  splits the SAME booked time by what filled it. Capacity is not
 *               per-service (services share one chair), so a service row reports
 *               its share of open time rather than a utilization of its own.
 *
 * Booked time counts native appointments AND external synced (Acuity/Square)
 * visits: both really occupied the chair. Canceled time is excluded (it was
 * given back); a no-show is included (nobody else could book that hour).
 *
 * TODAY is included but PRORATED - only the hours already past count as open, so
 * checking before lunch doesn't read as a slump. That keeps this card measuring
 * exactly the window the rest of the page counts.
 */
const utilizationQuerySchema = z.object({
  period: z.string().optional(),
  by: z.enum(["weekday", "period", "service"]).optional(),
  staffId: z.string().min(1).optional(),
});

insightsRouter.get("/utilization", async (req, res) => {
  const shop = req.shop!;
  const parsed = utilizationQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const by = parsed.data.by ?? "weekday";
  const now = new Date();
  const period = resolvePeriodWindow(now, shop.timezone, resolvePeriod(parsed.data.period));
  const staffFilter = parsed.data.staffId;

  // Concrete UTC bounds for the DB reads (pad a day so a shop-local day whose
  // instants straddle UTC midnight can't be clipped).
  const fetchFrom = new Date(period.windowStart.getTime() - DAY_MS);
  const fetchTo = new Date(period.today.getTime() + 2 * DAY_MS);
  const nowMin = minutesIntoLocalDay(now, shop.timezone);

  const [staffRows, rules, recurringBlocks, exceptions, chair] = await Promise.all([
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
    readChairEvents(shop.id, fetchFrom, fetchTo, {
      ...(staffFilter ? { staffId: staffFilter } : {}),
    }),
  ]);

  const staffIds = staffFilter
    ? staffRows.filter((s) => s.id === staffFilter).map((s) => s.id)
    : staffRows.map((s) => s.id);

  // --- Capacity, from the schedule, bucketed both ways in one pass ---
  // shopLocalDays re-derives local dates from the instants it is given, so it
  // must get real local-midnight instants - handing it the UTC-midnight markers
  // starts a day early and drops today entirely west of UTC.
  const days = shopLocalDays(
    localMidnightInstant(period.windowStart, shop.timezone),
    localMidnightInstant(period.today, shop.timezone),
    shop.timezone,
  );
  const openByWeekday = new Array(7).fill(0) as number[];
  const daysByWeekday = new Array(7).fill(0) as number[];
  const openByBucket = new Array(period.buckets.length).fill(0) as number[];
  const todayMs = period.today.getTime();

  for (const d of days) {
    // shopLocalDays yields the day's local midnight as a UTC instant; the
    // window's own days are UTC-midnight markers, so compare on the formatted
    // local day to stay in one coordinate system.
    const localDay = shopLocalDay(d.dayStartUtc, shop.timezone);
    const isToday = localDay.getTime() === todayMs;
    const open = openMinutesForDay({
      dayStartUtc: d.dayStartUtc,
      weekday: d.weekday,
      staffIds,
      rules,
      recurringBlocks,
      exceptions,
      // Today's remaining hours are still sellable, so they are not "open time
      // that went unsold" yet.
      ...(isToday ? { untilMin: nowMin } : {}),
    });
    openByWeekday[d.weekday] = (openByWeekday[d.weekday] ?? 0) + open;
    daysByWeekday[d.weekday] = (daysByWeekday[d.weekday] ?? 0) + 1;
    const bi = bucketIndexFor(period, localDay);
    if (bi >= 0) openByBucket[bi] = (openByBucket[bi] ?? 0) + open;
  }

  // --- Booked time, bucketed the same way ---
  const bookedByWeekday = new Array(7).fill(0) as number[];
  const countByWeekday = new Array(7).fill(0) as number[];
  const bookedByBucket = new Array(period.buckets.length).fill(0) as number[];
  const countByBucket = new Array(period.buckets.length).fill(0) as number[];
  const byService = new Map<
    string,
    { serviceId: string | null; name: string; min: number; count: number }
  >();
  const DEFAULT_MIN = 30; // a booking with no recorded end still held the chair

  for (const e of chair.events) {
    if (e.start > now) continue; // future bookings are capacity, not sold work
    const local = shopLocalDay(e.start, shop.timezone);
    const bi = bucketIndexFor(period, local);
    if (bi < 0) continue;
    const minutes =
      e.end && e.end > e.start
        ? Math.round((e.end.getTime() - e.start.getTime()) / 60_000)
        : DEFAULT_MIN;
    // JS getUTCDay on a UTC-midnight shop-local day == the shop-local weekday.
    const weekday = local.getUTCDay();
    bookedByWeekday[weekday] = (bookedByWeekday[weekday] ?? 0) + minutes;
    countByWeekday[weekday] = (countByWeekday[weekday] ?? 0) + 1;
    bookedByBucket[bi] = (bookedByBucket[bi] ?? 0) + minutes;
    countByBucket[bi] = (countByBucket[bi] ?? 0) + 1;
    const key = serviceKey(e);
    const s = byService.get(key) ?? {
      serviceId: e.serviceId,
      name: serviceLabel(e),
      min: 0,
      count: 0,
    };
    s.min += minutes;
    s.count += 1;
    byService.set(key, s);
  }

  const totalOpen = openByWeekday.reduce((a, b) => a + b, 0);
  const totalBooked = bookedByWeekday.reduce((a, b) => a + b, 0);
  const totalCount = countByWeekday.reduce((a, b) => a + b, 0);
  const pct = (booked: number, open: number): number | null =>
    open > 0 ? Math.round((booked / open) * 100) : null;

  // WEEKDAYS is Mon-first (matches the charts); JS weekday is Sun=0.
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
      : by === "period"
        ? period.buckets.map((b, i) => ({
            key: b.key,
            label: b.fullLabel,
            openMin: openByBucket[i]!,
            bookedMin: bookedByBucket[i]!,
            bookings: countByBucket[i]!,
            days: 0,
            utilizationPct: pct(bookedByBucket[i]!, openByBucket[i]!),
          }))
        : [...byService.values()]
            .sort((a, b) => b.min - a.min)
            .map((s) => ({
              key: s.serviceId ?? `name:${s.name}`,
              label: s.name,
              // Capacity is shared across services, so a service row reports the
              // slice of open time it filled - not a utilization of its own.
              openMin: 0,
              bookedMin: s.min,
              bookings: s.count,
              days: 0,
              utilizationPct: pct(s.min, totalOpen),
            }));

  res.json({
    ...periodMeta(period),
    by,
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
    // the UI shows booked time only instead of a meaningless 0% / infinity.
    noSchedule: totalOpen === 0,
    // A Visit carries no staff, so a per-barber view can only show native
    // bookings. The UI says so rather than quietly under-reporting.
    syncedExcluded: chair.syncedExcluded,
    // Capacity comes from the CURRENT weekly schedule; older days in the window
    // are measured against it. The UI says so rather than implying we kept
    // historical hours.
    scheduleCaveat: true,
  });
});

//  Quota goals ("$4,000 this month" / "60 cuts this week")

// Progress is derived from the SAME chair events the rest of the page counts, so
// a goal can never disagree with the chart above it.

const GOAL_METRICS = ["revenue", "visits"] as const;
const GOAL_PERIODS = ["week", "month"] as const;
type GoalMetric = (typeof GOAL_METRICS)[number];
type GoalPeriod = (typeof GOAL_PERIODS)[number];

/** Shop-local period window as UTC-midnight dates: [start, end). */
function periodWindow(
  now: Date,
  timezone: string,
  period: GoalPeriod,
): { start: Date; end: Date } {
  const today = shopLocalDay(now, timezone);
  if (period === "week") {
    const start = weekStart(today);
    return { start, end: new Date(start.getTime() + 7 * DAY_MS) };
  }
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  return { start, end };
}

/** Progress for ONE goal against a pre-read slice of chair events. */
function goalProgress(
  events: ChairEvent[],
  now: Date,
  timezone: string,
  goal: { metric: GoalMetric; period: GoalPeriod; target: number },
) {
  const { start, end } = periodWindow(now, timezone, goal.period);
  const totalDays = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  const today = shopLocalDay(now, timezone);
  // Day 1 = the period's first day. Clamp: a goal viewed outside its own period
  // (should not happen) still yields sane math.
  const elapsedDays = Math.min(
    totalDays,
    Math.max(1, Math.round((today.getTime() - start.getTime()) / DAY_MS) + 1),
  );

  // Per-day buckets across the whole period (future days stay 0 for the chart).
  const perDay = new Array<number>(totalDays).fill(0);
  let actual = 0;
  for (const e of events) {
    if (e.start > now) continue; // not earned yet
    const day = shopLocalDay(e.start, timezone);
    const idx = Math.round((day.getTime() - start.getTime()) / DAY_MS);
    if (idx < 0 || idx >= totalDays) continue; // outside this goal's period
    const amount = goal.metric === "revenue" ? (e.price ?? 0) : 1;
    perDay[idx]! += amount;
    actual += amount;
  }
  let running = 0;
  const series = perDay.map((amount, i) => {
    // Cumulative up to today; future days carry null so the chart's actual line
    // stops at "now" instead of flatlining to the period's end.
    if (i >= elapsedDays) return { day: i + 1, cumulative: null };
    running += amount;
    return { day: i + 1, cumulative: Math.round(running) };
  });

  const paceTarget = (goal.target * elapsedDays) / totalDays;
  return {
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
  };
}

/**
 * GET /api/insights/goal - every goal the shop has set, each with live progress.
 *
 * A shop can hold one target per (metric, period): "$4,000 a month" and "60 cuts
 * a week" are different goals and each keeps its own number. The response always
 * lists all four combinations so the UI can show which are set and which are
 * still empty without a second round trip.
 */
insightsRouter.get("/goal", async (req, res) => {
  const shop = req.shop!;
  const rows = await runWithShop(shop.id, (tx) =>
    tx.shopGoal.findMany({
      where: { shopId: shop.id },
      select: { metric: true, period: true, target: true },
    }),
  );

  const now = new Date();
  // One read covers both period shapes: the month window always contains the
  // week window unless the week straddles a month boundary, so span both.
  const monthWin = periodWindow(now, shop.timezone, "month");
  const weekWin = periodWindow(now, shop.timezone, "week");
  const from = new Date(
    Math.min(monthWin.start.getTime(), weekWin.start.getTime()) - DAY_MS,
  );
  const to = new Date(Math.max(monthWin.end.getTime(), weekWin.end.getTime()) + DAY_MS);
  const { events } = rows.length > 0
    ? await readChairEvents(shop.id, from, to)
    : { events: [] as ChairEvent[] };

  const set = new Map(rows.map((r) => [`${r.metric}:${r.period}`, r.target]));
  const goals = GOAL_METRICS.flatMap((metric) =>
    GOAL_PERIODS.map((period) => {
      const target = set.get(`${metric}:${period}`) ?? null;
      return {
        metric,
        period,
        target,
        progress:
          target === null
            ? null
            : goalProgress(events, now, shop.timezone, { metric, period, target }),
      };
    }),
  );

  res.json({ goals });
});

const goalSchema = z
  .object({
    metric: z.enum(GOAL_METRICS),
    period: z.enum(GOAL_PERIODS),
    // Whole dollars or cut count. Upper bound is a sanity rail, not a limit
    // anyone real will hit.
    target: z.number().int().min(1).max(1_000_000),
  })
  .strict();

// PUT /api/insights/goal - set or replace the target for ONE (metric, period).
// The other combinations are untouched, so switching the toggle in the UI can
// never wipe a goal the barber set earlier.
insightsRouter.put("/goal", async (req, res) => {
  const shop = req.shop!;
  const parsed = goalSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const { metric, period, target } = parsed.data;
  await runWithShop(shop.id, (tx) =>
    tx.shopGoal.upsert({
      where: {
        shopId_metric_period: { shopId: shop.id, metric, period },
      },
      create: { shopId: shop.id, metric, period, target },
      update: { target },
    }),
  );
  res.json({ ok: true });
});

const clearGoalSchema = z
  .object({
    metric: z.enum(GOAL_METRICS).optional(),
    period: z.enum(GOAL_PERIODS).optional(),
  })
  .strict();

// DELETE /api/insights/goal?metric=&period= - clear ONE goal. With neither, all
// of them. deleteMany: idempotent, no 404 dance.
insightsRouter.delete("/goal", async (req, res) => {
  const shop = req.shop!;
  const parsed = clearGoalSchema.safeParse(req.query ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const { metric, period } = parsed.data;
  await runWithShop(shop.id, (tx) =>
    tx.shopGoal.deleteMany({
      where: {
        shopId: shop.id,
        ...(metric ? { metric } : {}),
        ...(period ? { period } : {}),
      },
    }),
  );
  res.json({ ok: true });
});

export type { PeriodKey };
