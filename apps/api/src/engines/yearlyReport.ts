import { runWithShop, type Prisma } from "@chairback/db";
import { zonedWallTimeToUtc } from "@chairback/config";
import {
  DAY_MS,
  WEEKDAYS,
  readChairEvents,
  serviceKey,
  serviceLabel,
  shopLocalDay,
  type ChairEvent,
} from "./insightsWindow.js";

/**
 * One calendar year of a barber's - or a shop's - verified ChairBack numbers.
 *
 * 🔴 THIS IS NOT A SECOND ANALYTICS SYSTEM. Every figure below is read off the
 * SAME `readChairEvents` stream that draws the Insights page, filtered by the
 * SAME in-window predicate (`start <= now`, shop-local day inside the range)
 * and totalled with the SAME definitions of a cut, of revenue and of a client.
 * A barber prints this and hands it to an accountant, a landlord or an awards
 * panel - the day it disagrees with the screen he checked it against, it stops
 * being evidence and becomes a liability. The falsifier for that is
 * `yearlyReportMatchesInsights.test.ts`, which asks BOTH endpoints for the same
 * span and compares totals field by field.
 *
 * WHAT PUTS AN APPOINTMENT IN A YEAR: its SCHEDULED START, in the shop's
 * timezone. Not the completion time, not the settlement time. That is the
 * definition Insights has always used (readChairEvents filters `startsAt` /
 * `scheduledAt`), it is the only one all four booking systems can supply, and
 * it is the one a barber means by "how many cuts did I do in March". It is
 * stated on the printed page so nobody has to guess.
 *
 * WHAT IS DELIBERATELY ABSENT: any statistic ChairBack cannot stand behind.
 * Tips are not a column anywhere in the schema (`Shop.tipPolicy` is a sentence
 * shown to customers, not an amount), and no payment row records cash versus
 * card at the chair. Those come back as `unavailable` entries with a reason,
 * and the report prints the reason. Guessing them would be the one failure a
 * document like this cannot survive.
 */

/** Money is only ever integer cents in this module, and the unit says so. */
export const REPORT_CURRENCY = "USD" as const;

/** How far back a year may be asked for. Before this, ChairBack did not exist. */
export const EARLIEST_REPORT_YEAR = 2024;

export interface YearlyMonth {
  /** "2026-03" - stable key for React and for row lookups. */
  key: string;
  /** "Mar" - the axis label. */
  label: string;
  /** "March 2026" - the tooltip / long form. */
  fullLabel: string;
  appointments: number;
  revenueCents: number;
  /** False for a month the window does not fully cover (the current one). */
  complete: boolean;
}

export interface YearlyServiceRow {
  name: string;
  count: number;
  revenueCents: number;
}

/**
 * A number the report cannot honestly print, and why. Rendered as an explicit
 * "not tracked" line rather than omitted - a missing row reads as a zero.
 */
export interface UnavailableMetric {
  key: string;
  label: string;
  reason: string;
}

export interface YearlyReport {
  year: number;
  /** True when `year` is the year in progress: the window ends at `now`. */
  yearToDate: boolean;
  /** "2026 year to date" or "2026". The one label every surface prints. */
  periodLabel: string;
  timezone: string;
  currency: typeof REPORT_CURRENCY;
  /** Shop-local YYYY-MM-DD, inclusive. */
  rangeStart: string;
  /** Shop-local YYYY-MM-DD, inclusive. */
  rangeEnd: string;
  /** ISO instant the figures were read at. */
  generatedAt: string;

  shopName: string;
  /** The barber this covers, or null for the whole shop. */
  staffId: string | null;
  /** "Eric Chernichaw" or the shop name when this is the shop report. */
  subjectName: string;
  scope: "shop" | "staff";
  /**
   * The shop's own word for a provider - "barber", "stylist", "nail tech".
   *
   * Resolved from the business type, never hard-coded: a salon printing
   * "Barber at Glow Studio" on a document its owner hands to a landlord is the
   * exact failure packages/config/vocabularyLint.test.ts exists to prevent, and
   * a printed page cannot be quietly corrected later.
   */
  providerNoun: string;
  /**
   * True when this is one barber's report and the shop also has externally
   * synced (Acuity/Square) bookings, which carry no barber and are therefore
   * NOT in these numbers. The page says so - a barber must not read a
   * per-chair total as the shop's.
   */
  syncedExcluded: boolean;

  totals: {
    /** Bookings that occupied the chair and were not a no-show. */
    appointments: number;
    /** Chairs held for someone who never came. */
    noShows: number;
    /** Bookings canceled before they happened (never counted as work). */
    cancellations: number;
    /** appointments + noShows + cancellations - the denominator for the rates. */
    booked: number;
    /** Basis points (1/100 of a percent) so the rate stays an integer. */
    noShowRateBp: number | null;
    cancellationRateBp: number | null;

    uniqueClients: number;
    newClients: number;
    returningClients: number;
    /** returningClients / uniqueClients, in basis points. */
    returnRateBp: number | null;
    /** Bookings taken with no client record - real cuts, not attributable. */
    walkIns: number;

    revenueCents: number;
    /** revenueCents / months in the window (elapsed months, not always 12). */
    avgMonthlyRevenueCents: number;
    /** The ticket, over PRICED non-no-show bookings only. */
    avgTicketCents: number | null;
    pricedCount: number;
    unpricedCount: number;

    /** Revenue that settled through ChairBack (Stripe), net of refunds. */
    settledThroughChairbackCents: number;
    /** Everything else: taken at the chair, or synced from another system. */
    collectedInPersonCents: number;
  };

  busiest: {
    /** "Mar", or null when the year has no bookings at all. */
    month: string | null;
    monthKey: string | null;
    /** "Sat", or null. */
    weekday: string | null;
    /** Mon..Sun counts, so the report can draw the spread, not just the peak. */
    weekdayCounts: number[];
  };

  months: YearlyMonth[];
  /** Top services by booking count. Empty for an empty year. */
  services: YearlyServiceRow[];
  unavailable: UnavailableMetric[];
}

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** A UTC-midnight shop-local day marker as YYYY-MM-DD. */
function ymd(marker: Date): string {
  return marker.toISOString().slice(0, 10);
}

/** basis points, or null when the denominator is 0 (never 0/0 = "0%"). */
function rateBp(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000);
}

/** Which calendar year `now` falls in, in the shop's zone. */
export function currentShopYear(now: Date, timezone: string): number {
  return shopLocalDay(now, timezone).getUTCFullYear();
}

/**
 * The years a shop may ask for: EARLIEST_REPORT_YEAR through the year in
 * progress, newest first.
 *
 * Deliberately NOT anchored on the shop's `createdAt`. A shop that signed up
 * this year and ran the Acuity backfill has last year's visits on the books,
 * and last year is exactly the report it wants to print; keying the picker on
 * the signup date hid that year from it. An empty year costs nothing - it
 * renders the same one-page document with honest zeros (pinned in
 * yearlyReport.test.ts), and a barber who picks it learns something true.
 */
export function selectableYears(now: Date, timezone: string): number[] {
  const current = currentShopYear(now, timezone);
  const out: number[] = [];
  for (let y = current; y >= EARLIEST_REPORT_YEAR; y--) out.push(y);
  return out;
}

/**
 * The exact instants a shop-local calendar year spans.
 *
 * Both ends go through `zonedWallTimeToUtc`, which resolves the real UTC offset
 * at each boundary - so a zone that changed its DST rules, or a year whose
 * January 1 sits on a different offset than its December 31, still lands on
 * midnight-to-midnight local. `endExclusive` is the NEXT year's January 1, so
 * December 31 is included whole and January 1 of the following year can never
 * leak in. Leap years need no special case at all: February 29 is simply a day
 * inside the range.
 */
export function shopYearBounds(
  year: number,
  timezone: string,
): { start: Date; endExclusive: Date } {
  return {
    start: zonedWallTimeToUtc(year, 0, 1, 0, timezone),
    endExclusive: zonedWallTimeToUtc(year + 1, 0, 1, 0, timezone),
  };
}

/** The 12 shop-local month markers of `year`, as UTC-midnight day markers. */
function monthMarkers(year: number): { start: Date; end: Date }[] {
  const out: { start: Date; end: Date }[] = [];
  for (let m = 0; m < 12; m++) {
    out.push({
      start: new Date(Date.UTC(year, m, 1)),
      end: new Date(Date.UTC(year, m + 1, 1)),
    });
  }
  return out;
}

export interface BuildYearlyReportInput {
  shopId: string;
  shopName: string;
  timezone: string;
  /** The shop's word for a provider; defaults to the neutral one. */
  providerNoun?: string;
  year: number;
  /** One barber's report, or null for the whole shop. */
  staffId: string | null;
  /** The barber's display name; ignored when staffId is null. */
  staffName?: string | null;
  now: Date;
}

/**
 * Read one year and total it.
 *
 * Runs in ONE shop-scoped transaction: Appointment, Visit and Client are all
 * FORCE-RLS tables, and every `runWithShop` is a real BEGIN/SET/COMMIT round
 * trip. A year is a big read but it is four queries, not four hundred.
 */
export async function buildYearlyReport(
  input: BuildYearlyReportInput,
): Promise<YearlyReport> {
  const { shopId, timezone, year, staffId, now } = input;
  const { start, endExclusive } = shopYearBounds(year, timezone);
  const todayLocal = shopLocalDay(now, timezone);
  const yearToDate = currentShopYear(now, timezone) === year;

  // The window's last measured day. For a finished year that is Dec 31; for the
  // year in progress it is today, and `start > now` events are dropped below so
  // tomorrow's booking never counts as work already done.
  const lastDayMarker = yearToDate
    ? todayLocal
    : new Date(Date.UTC(year, 11, 31));
  const firstDayMarker = new Date(Date.UTC(year, 0, 1));

  // Pad the DB filter a day each side: a shop-local day's instants straddle UTC
  // midnight, and the shop-local bucket check below is what actually decides
  // membership. Without the pad, a Dec 31 11pm New York cut (Jan 1 04:00 UTC)
  // would be filtered out before it could be classified.
  const fetchFrom = new Date(start.getTime() - DAY_MS);
  const fetchTo = new Date(
    Math.min(endExclusive.getTime(), now.getTime() + DAY_MS) + DAY_MS,
  );

  const { events, syncedExcluded, canceled, firstVisits, firstAppts } =
    await runWithShop(shopId, async (tx) => {
      const { events, syncedExcluded } = await readChairEvents(
        shopId,
        fetchFrom,
        fetchTo,
        { tx, ...(staffId ? { staffId } : {}) },
      );

      // Cancellations are the one figure Insights does not draw, because a
      // canceled hour is not work and never belonged on a chart of work. A
      // yearly report needs it: "I was canceled on 40 times" is exactly the
      // context that explains a revenue line, and its rate is a professional
      // number a barber is asked for. Read here, with the same start-time
      // window and the same staff scoping as everything else, so it can never
      // be measured over a different span than the rest of the page.
      const canceled = await countCanceled(tx, {
        shopId,
        staffId,
        from: fetchFrom,
        to: fetchTo,
        timezone,
        firstDayMarker,
        lastDayMarker,
        now,
      });

      const ids = new Set<string>();
      for (const e of events) {
        if (!inWindow(e, timezone, firstDayMarker, lastDayMarker, now)) continue;
        if (e.clientId) ids.add(e.clientId);
      }
      const idList = [...ids];
      // NEW vs RETURNING asks when this person FIRST came to this shop, ever -
      // across both booking systems. A client whose first visit was on Acuity
      // in 2023 is not "new in 2026" because his first native booking happens
      // to fall there. Same two groupBys Insights uses, same predicates.
      const firstVisits =
        idList.length === 0
          ? []
          : await tx.visit.groupBy({
              by: ["clientId"],
              where: {
                shopId,
                status: { in: ["SCHEDULED", "RESCHEDULED", "COMPLETED", "NO_SHOW"] },
                clientId: { in: idList },
              },
              _min: { scheduledAt: true },
            });
      const firstAppts =
        idList.length === 0
          ? []
          : await tx.appointment.groupBy({
              by: ["clientId"],
              where: {
                shopId,
                holdExpiresAt: null,
                status: { in: ["BOOKED", "COMPLETED", "NO_SHOW"] },
                clientId: { in: idList },
              },
              _min: { startsAt: true },
            });
      return { events, syncedExcluded, canceled, firstVisits, firstAppts };
    });

  const months: YearlyMonth[] = monthMarkers(year).map((m, i) => ({
    key: `${year}-${String(i + 1).padStart(2, "0")}`,
    label: MONTHS_SHORT[i]!,
    fullLabel: `${MONTHS_LONG[i]!} ${year}`,
    appointments: 0,
    revenueCents: 0,
    // A month is complete when its last day is at or before the window's last
    // measured day. For a finished year every month is; for the year in
    // progress the current month is not, and neither is any future month.
    complete: new Date(m.end.getTime() - DAY_MS).getTime() <= lastDayMarker.getTime(),
  }));

  const byService = new Map<string, YearlyServiceRow>();
  const weekdayCounts = [0, 0, 0, 0, 0, 0, 0]; // Mon..Sun
  const clientIds = new Set<string>();

  let appointments = 0;
  let noShows = 0;
  let walkIns = 0;
  let revenueCents = 0;
  let settledCents = 0;
  let pricedCents = 0;
  let pricedCount = 0;
  let countedEvents = 0;

  for (const e of events) {
    if (!inWindow(e, timezone, firstDayMarker, lastDayMarker, now)) continue;
    const day = shopLocalDay(e.start, timezone);
    const monthIndex = day.getUTCMonth();
    const month = months[monthIndex]!;

    countedEvents++;
    month.appointments++;
    month.revenueCents += e.earnedCents;
    weekdayCounts[(day.getUTCDay() + 6) % 7]!++;
    revenueCents += e.earnedCents;
    if (e.settledCents) settledCents += e.settledCents;
    if (e.clientId) clientIds.add(e.clientId);
    else walkIns++;
    if (e.noShow) noShows++;
    else appointments++;
    // Average TICKET reads the price of the WORK: an unpriced walk-in is not a
    // $0 sale and a no-show is not a sale at all. Identical to Insights.
    if (e.priceCents !== null && !e.noShow) {
      pricedCents += e.priceCents;
      pricedCount++;
    }

    const key = serviceKey(e);
    const row = byService.get(key) ?? {
      name: serviceLabel(e),
      count: 0,
      revenueCents: 0,
    };
    row.count++;
    row.revenueCents += e.earnedCents;
    byService.set(key, row);
  }

  let newClients = 0;
  if (clientIds.size > 0) {
    const firstEver = new Map<string, Date>();
    const note = (clientId: string | null, at: Date | null) => {
      if (!clientId || !at) return;
      const prev = firstEver.get(clientId);
      if (!prev || at < prev) firstEver.set(clientId, at);
    };
    for (const f of firstVisits) note(f.clientId, f._min.scheduledAt);
    for (const f of firstAppts) note(f.clientId, f._min.startsAt);
    for (const at of firstEver.values()) {
      if (shopLocalDay(at, timezone) >= firstDayMarker) newClients++;
    }
  }

  // Months ELAPSED, not twelve. A report pulled in March that divided a
  // quarter's takings by twelve would understate the barber by a factor of
  // four - on a document he may hand to a lender.
  const monthsElapsed = yearToDate ? todayLocal.getUTCMonth() + 1 : 12;

  const busiestMonthIndex = months.some((m) => m.appointments > 0)
    ? months.reduce((best, m, i) => (m.appointments > months[best]!.appointments ? i : best), 0)
    : -1;
  const busiestWeekdayIndex = weekdayCounts.some((c) => c > 0)
    ? weekdayCounts.indexOf(Math.max(...weekdayCounts))
    : -1;

  const booked = appointments + noShows + canceled;

  return {
    year,
    yearToDate,
    periodLabel: yearToDate ? `${year} year to date` : String(year),
    timezone,
    currency: REPORT_CURRENCY,
    rangeStart: ymd(firstDayMarker),
    rangeEnd: ymd(lastDayMarker),
    generatedAt: now.toISOString(),

    shopName: input.shopName,
    staffId,
    subjectName: staffId ? (input.staffName?.trim() || "This barber") : input.shopName,
    scope: staffId ? "staff" : "shop",
    providerNoun: input.providerNoun?.trim() || "provider",
    syncedExcluded,

    totals: {
      appointments,
      noShows,
      cancellations: canceled,
      booked,
      noShowRateBp: rateBp(noShows, booked),
      cancellationRateBp: rateBp(canceled, booked),

      uniqueClients: clientIds.size,
      newClients,
      returningClients: clientIds.size - newClients,
      returnRateBp: rateBp(clientIds.size - newClients, clientIds.size),
      walkIns,

      revenueCents,
      avgMonthlyRevenueCents:
        monthsElapsed > 0 ? Math.round(revenueCents / monthsElapsed) : 0,
      avgTicketCents: pricedCount > 0 ? Math.round(pricedCents / pricedCount) : null,
      pricedCount,
      unpricedCount: countedEvents - pricedCount,

      settledThroughChairbackCents: settledCents,
      collectedInPersonCents: Math.max(0, revenueCents - settledCents),
    },

    busiest: {
      month: busiestMonthIndex >= 0 ? MONTHS_SHORT[busiestMonthIndex]! : null,
      monthKey: busiestMonthIndex >= 0 ? months[busiestMonthIndex]!.key : null,
      weekday: busiestWeekdayIndex >= 0 ? WEEKDAYS[busiestWeekdayIndex]! : null,
      weekdayCounts,
    },

    months,
    services: [...byService.values()]
      .filter((s) => s.count > 0)
      .sort((a, b) => b.count - a.count || b.revenueCents - a.revenueCents)
      .slice(0, 6),
    unavailable: UNAVAILABLE_METRICS,
  };
}

/**
 * The figures ChairBack is asked for and cannot prove. Printed as named "not
 * tracked" lines, because on a document like this an absent row reads as a
 * zero and a zero reads as a fact.
 */
export const UNAVAILABLE_METRICS: UnavailableMetric[] = [
  {
    key: "tips",
    label: "Tips",
    reason: "ChairBack does not record tip amounts, so none can be reported.",
  },
  {
    key: "cardVsCash",
    label: "Card vs cash",
    reason:
      "Payment method is only known for money taken through ChairBack. Cash and card at the chair are not told apart.",
  },
];

/** Is this event inside the measured window, and has it actually happened? */
function inWindow(
  e: Pick<ChairEvent, "start">,
  timezone: string,
  firstDayMarker: Date,
  lastDayMarker: Date,
  now: Date,
): boolean {
  // A booking in the future has not happened: it must not count as work done
  // and it must not appear as revenue already earned. Same rule as Insights.
  if (e.start > now) return false;
  const day = shopLocalDay(e.start, timezone);
  return (
    day.getTime() >= firstDayMarker.getTime() && day.getTime() <= lastDayMarker.getTime()
  );
}

/**
 * Bookings that were canceled, counted on the same start-time window.
 *
 * Native CANCELED appointments and synced CANCELED visits both count. Rows
 * that were never a real booking are excluded: an unpromoted payment/
 * receptionist HOLD is canceled by the sweep when it lapses, and counting
 * those would report every abandoned checkout as a customer cancellation and
 * make the rate meaningless.
 */
async function countCanceled(
  tx: Prisma.TransactionClient,
  opts: {
    shopId: string;
    staffId: string | null;
    from: Date;
    to: Date;
    timezone: string;
    firstDayMarker: Date;
    lastDayMarker: Date;
    now: Date;
  },
): Promise<number> {
  const appts = await tx.appointment.findMany({
    where: {
      shopId: opts.shopId,
      ...(opts.staffId ? { staffId: opts.staffId } : {}),
      status: "CANCELED",
      // A lapsed hold is not a cancellation. holdExpiresAt is cleared the
      // moment a hold becomes a real booking, so "null" is exactly the set of
      // rows that were genuinely on the books.
      holdExpiresAt: null,
      startsAt: { gte: opts.from, lt: opts.to },
    },
    select: { startsAt: true },
  });
  // Synced visits carry no staff, so a per-barber report cannot claim them -
  // the same rule readChairEvents applies to synced work generally.
  const visits = opts.staffId
    ? []
    : await tx.visit.findMany({
        where: {
          shopId: opts.shopId,
          appointment: null,
          status: "CANCELED",
          scheduledAt: { gte: opts.from, lt: opts.to },
        },
        select: { scheduledAt: true },
      });

  let n = 0;
  for (const a of appts) {
    if (inWindow({ start: a.startsAt }, opts.timezone, opts.firstDayMarker, opts.lastDayMarker, opts.now)) n++;
  }
  for (const v of visits) {
    if (inWindow({ start: v.scheduledAt }, opts.timezone, opts.firstDayMarker, opts.lastDayMarker, opts.now)) n++;
  }
  return n;
}
