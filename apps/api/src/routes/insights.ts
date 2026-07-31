import { Router } from "express";
import { z } from "zod";
import { prisma, runWithShop } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireManager } from "../auth/roles.js";

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
