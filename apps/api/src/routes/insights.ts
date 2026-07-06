import { Router } from "express";
import { prisma } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";

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
insightsRouter.use(requireUser, requireShop);

const WEEK_CHOICES = [8, 12, 26] as const;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * A visit's calendar day in the shop's timezone. en-CA formats as YYYY-MM-DD,
 * which we reinterpret as a UTC date for stable week math. Weeks must bucket in
 * shop-local time: a Friday 11pm cut in New York is Saturday in UTC, and
 * "cuts per week" that shifts late appointments into the wrong week reads
 * wrong to the barber.
 */
function shopLocalDay(d: Date, timezone: string): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
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
      where: { shopId: shop.id, createdAt: { gte: windowStart } },
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
