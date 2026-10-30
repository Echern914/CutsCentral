import type { Prisma } from "@chairback/db";
import {
  STATS_GRAINS,
  STATS_MAX_PERIODS,
  STATS_METRICS,
  suggestGoal,
  type GoalSuggestion,
  type StatsGrain,
  type StatsMetricKey,
} from "@chairback/config/insightsStats";
import {
  DAY_MS,
  bucketIndexFor,
  localMidnightInstant,
  readChairEvents,
  resolveTrailingWindow,
  shopLocalDay,
  type ChairEvent,
  type ResolvedPeriod,
} from "./insightsWindow.js";
import {
  appointmentTipSnapshot,
  stripeCollectedCents,
  type PaymentRowFacts,
} from "./appointmentPayment.js";

/**
 * THE STATS STRIP: every card's series for one grain, in one read.
 *
 * NOT A SECOND REVENUE RULE. Bookings, revenue, average ticket, hours and
 * no-shows all come off `readChairEvents` - the same stream every other card
 * on Insights reads, synced Acuity/Square visits included. The only two reads
 * this adds are facts that stream does not carry:
 *   - TIPS (an online `tip` Payment row plus a recorded cash / other-app tip,
 *     added by appointmentTipSnapshot - deliberately kept out of revenue), and
 *   - each client's FIRST-EVER booking, for "new clients" (the same two
 *     groupBys GET /api/insights already runs).
 *
 * Every period edge is a SHOP-LOCAL day / Monday / 1st of the month: an 11:30pm
 * cut in New York belongs to that Friday, not to Saturday UTC.
 */

/** Visits with no recorded end held the chair this long - matches Chair time. */
const DEFAULT_BOOKED_MIN = 30;

/** Complete-period history behind each suggested goal (current period excluded). */
const SUGGEST_HISTORY: Record<"week" | "month", number> = { week: 10, month: 7 };

export type StatsSeries = Record<StatsMetricKey, (number | null)[]>;

export interface StatsTip {
  /** The visit's start - a tip is filed under the visit it was left for. */
  start: Date;
  cents: number;
}

/**
 * Tally one window. Pure: everything it needs is passed in, so the timezone
 * and boundary rules are testable without a database.
 *
 *   bookings    visits that happened (start <= now), no-shows excluded
 *   revenue     ChairEvent.earnedCents - the one revenue rule (no-show fees in)
 *   avgTicket   mean ticket over priced visits that happened, null with none -
 *               the same rule as the page's Avg ticket tile
 *   tips        online tips net of refunds + recorded tips, by the visit's day
 *   hoursBooked minutes in the chair, no-shows included (Chair time's rule)
 *   newClients  clients whose first-ever booking falls in the period
 *   noShows     chairs held for someone who never came
 */
export function tallyStats(
  period: ResolvedPeriod,
  input: {
    events: ChairEvent[];
    tips: StatsTip[];
    firstEver: Map<string, Date>;
    now: Date;
    timezone: string;
  },
): StatsSeries {
  const n = period.buckets.length;
  const zeros = () => new Array<number>(n).fill(0);
  const bookings = zeros();
  const revenue = zeros();
  const ticketSum = zeros();
  const ticketCount = zeros();
  const tips = zeros();
  const minutes = zeros();
  const newClients = zeros();
  const noShows = zeros();
  const indexOf = (d: Date) => bucketIndexFor(period, shopLocalDay(d, input.timezone));

  for (const e of input.events) {
    if (e.start > input.now) continue; // not happened yet
    const i = indexOf(e.start);
    if (i < 0) continue; // read padding, not the window
    revenue[i]! += e.earnedCents;
    minutes[i]! +=
      e.end && e.end > e.start
        ? Math.round((e.end.getTime() - e.start.getTime()) / 60_000)
        : DEFAULT_BOOKED_MIN;
    if (e.noShow) {
      noShows[i]!++;
      continue;
    }
    bookings[i]!++;
    if (e.priceCents !== null) {
      ticketSum[i]! += e.priceCents;
      ticketCount[i]!++;
    }
  }
  for (const t of input.tips) {
    if (t.start > input.now) continue;
    const i = indexOf(t.start);
    if (i >= 0) tips[i]! += t.cents;
  }
  for (const at of input.firstEver.values()) {
    if (at > input.now) continue;
    const i = indexOf(at);
    if (i >= 0) newClients[i]!++;
  }

  return {
    bookings,
    revenue,
    avgTicket: ticketCount.map((c, i) => (c > 0 ? Math.round(ticketSum[i]! / c) : null)),
    tips,
    hoursBooked: minutes,
    newClients,
    noShows,
  };
}

export interface StatsResult {
  grain: StatsGrain;
  period: ResolvedPeriod;
  series: StatsSeries;
  /**
   * The PREVIOUS period, counted only up to the point the current one has
   * reached (yesterday until this time of day, last week until this weekday and
   * time, last month until this date and time). The current period is never
   * finished, so comparing it with a whole previous period would read as a drop
   * every morning; this is the like-for-like number the arrow compares against.
   */
  previousToDate: Record<StatsMetricKey, number | null>;
  /** True when this shop has online tips on, or has ever been tipped in the window. */
  tipsTracked: boolean;
  suggestions: GoalSuggestion[];
}

/**
 * Read once, tally the chosen grain, and work out the week + month goal
 * suggestions from the same rows. The read is bounded by the longest window
 * any of those needs (at most 12 months), never by the caller.
 */
export async function readStats(
  tx: Prisma.TransactionClient,
  shop: { id: string; timezone: string; onlineTipsEnabled: boolean },
  grain: StatsGrain,
  now: Date,
): Promise<StatsResult> {
  const count = Math.min(STATS_GRAINS[grain].count, STATS_MAX_PERIODS);
  const period = resolveTrailingWindow(now, shop.timezone, grain, count);
  const weekWin = resolveTrailingWindow(now, shop.timezone, "week", SUGGEST_HISTORY.week);
  const monthWin = resolveTrailingWindow(now, shop.timezone, "month", SUGGEST_HISTORY.month);

  // Real instants for the DB filter, padded a day each side so a shop-local
  // day straddling UTC midnight is never clipped; the bucket check drops the
  // padding again.
  const earliest = Math.min(
    period.windowStart.getTime(),
    weekWin.windowStart.getTime(),
    monthWin.windowStart.getTime(),
  );
  const from = new Date(earliest - DAY_MS);
  const to = new Date(period.today.getTime() + 2 * DAY_MS);

  const { events } = await readChairEvents(shop.id, from, to, { tx });

  // Tips, by the visit they were left on: the online tip (what Stripe settled,
  // net of refunds) plus a cash / other-app tip the shop recorded on the
  // sheet's Tip row. Both go through appointmentTipSnapshot - the one place a
  // visit's tips are added - so this card and the sheet can never disagree.
  // Tips stay OUT of revenue.
  const tipAppts = await tx.appointment.findMany({
    where: {
      shopId: shop.id,
      startsAt: { gte: from, lt: to },
      OR: [{ recordedTipCents: { not: null } }, { payments: { some: { purpose: "tip" } } }],
    },
    select: {
      startsAt: true,
      recordedTipCents: true,
      recordedTipMethod: true,
      payments: {
        where: { purpose: "tip" },
        select: { status: true, amount: true, capturedAmount: true, refundedAmount: true },
      },
    },
  });
  // At most one LIVE tip per visit (Payment_appointmentId_tip_live_key); a
  // failed attempt beside it collects nothing, so the live one is the one
  // that collected the most.
  const liveTip = (rows: PaymentRowFacts[]) =>
    rows.reduce<PaymentRowFacts | null>(
      (best, p) => (best === null || stripeCollectedCents(p) > stripeCollectedCents(best) ? p : best),
      null,
    );
  const tips: StatsTip[] = tipAppts
    .map((a) => ({
      start: a.startsAt,
      cents: appointmentTipSnapshot({
        online: liveTip(a.payments),
        recorded:
          a.recordedTipCents !== null && a.recordedTipMethod !== null
            ? { cents: a.recordedTipCents, method: a.recordedTipMethod }
            : null,
      }).totalCents,
    }))
    .filter((t) => t.cents > 0);

  // First-ever booking for each client seen in the DISPLAYED window, across
  // both systems: a client whose first visit was on Acuity is not new because
  // their first native booking happens to be this week.
  const ids = new Set<string>();
  for (const e of events) {
    if (e.start > now || !e.clientId) continue;
    if (bucketIndexFor(period, shopLocalDay(e.start, shop.timezone)) < 0) continue;
    ids.add(e.clientId);
  }
  const firstEver = new Map<string, Date>();
  if (ids.size > 0) {
    const idList = [...ids];
    const firstVisits = await tx.visit.groupBy({
      by: ["clientId"],
      where: {
        shopId: shop.id,
        status: { in: ["SCHEDULED", "RESCHEDULED", "COMPLETED", "NO_SHOW"] },
        clientId: { in: idList },
      },
      _min: { scheduledAt: true },
    });
    const firstAppts = await tx.appointment.groupBy({
      by: ["clientId"],
      where: {
        shopId: shop.id,
        holdExpiresAt: null,
        status: { in: ["BOOKED", "COMPLETED", "NO_SHOW"] },
        clientId: { in: idList },
      },
      _min: { startsAt: true },
    });
    const note = (clientId: string | null, at: Date | null) => {
      if (!clientId || !at) return;
      const prev = firstEver.get(clientId);
      if (!prev || at < prev) firstEver.set(clientId, at);
    };
    for (const f of firstVisits) note(f.clientId, f._min.scheduledAt);
    for (const f of firstAppts) note(f.clientId, f._min.startsAt);
  }

  const input = { events, tips, firstEver, now, timezone: shop.timezone };
  const series = tallyStats(period, input);
  const previousToDate = tallyPreviousToDate(period, input);

  // Suggestions read bookings + revenue only, so they skip the tips and
  // new-client inputs; the current (unfinished) period is dropped.
  const historyInput = { ...input, tips: [], firstEver: new Map<string, Date>() };
  const complete = (s: (number | null)[]) => s.slice(0, -1).map((v) => v ?? 0);
  const weekSeries = tallyStats(weekWin, historyInput);
  const monthSeries = tallyStats(monthWin, historyInput);
  const toDollars = (s: (number | null)[]) => complete(s).map((c) => c / 100);
  const suggestions = [
    suggestGoal("revenue", "week", toDollars(weekSeries.revenue)),
    suggestGoal("visits", "week", complete(weekSeries.bookings)),
    suggestGoal("revenue", "month", toDollars(monthSeries.revenue)),
    suggestGoal("visits", "month", complete(monthSeries.bookings)),
  ].filter((s): s is GoalSuggestion => s !== null);

  return {
    grain,
    period,
    series,
    previousToDate,
    tipsTracked: shop.onlineTipsEnabled || tips.length > 0,
    suggestions,
  };
}

/**
 * Where an instant sits on the shop's wall clock, as a UTC-midnight-style
 * marker plus the time since that local midnight - comparable with a bucket's
 * `start` marker.
 */
function localWallMs(d: Date, timezone: string): number {
  const day = shopLocalDay(d, timezone);
  return day.getTime() + (d.getTime() - localMidnightInstant(day, timezone).getTime());
}

/**
 * The previous bucket, tallied only up to the same offset into it that `now`
 * has reached in the current bucket. Pure, like tallyStats.
 */
export function tallyPreviousToDate(
  period: ResolvedPeriod,
  input: Parameters<typeof tallyStats>[1],
): Record<StatsMetricKey, number | null> {
  const last = period.buckets.length - 1;
  const cur = period.buckets[last];
  const prev = period.buckets[last - 1];
  const keys = STATS_METRICS.map((m) => m.key);
  if (!cur || !prev) return Object.fromEntries(keys.map((k) => [k, null])) as Record<StatsMetricKey, number | null>;
  const reached = localWallMs(input.now, input.timezone) - cur.start.getTime();
  const inReach = (d: Date) => {
    const offset = localWallMs(d, input.timezone) - prev.start.getTime();
    return offset >= 0 && offset <= reached && localWallMs(d, input.timezone) < prev.end.getTime();
  };
  const firstEver = new Map([...input.firstEver].filter(([, at]) => inReach(at)));
  const s = tallyStats(period, {
    ...input,
    events: input.events.filter((e) => inReach(e.start)),
    tips: input.tips.filter((t) => inReach(t.start)),
    firstEver,
  });
  return Object.fromEntries(keys.map((k) => [k, s[k][last - 1] ?? null])) as Record<StatsMetricKey, number | null>;
}

