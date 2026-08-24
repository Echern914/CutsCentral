import { runWithShop, type Prisma } from "@chairback/db";
import { zonedWallTimeToUtc } from "@chairback/config";

/**
 * ONE definition of "the window" and "a cut", shared by every card on Insights.
 *
 * The page used to disagree with itself: the weekly chart, top services and the
 * totals were built from COMPLETED `Visit` rows, while Chair time was built from
 * `Appointment` + externally-synced `Visit` rows. Native bookings only become
 * Visits when the promotion cron runs (every 15 min, and never at all for a
 * walk-in with no Client, because Visit.clientId is NOT NULL) - so a native shop
 * could see a full Chair time card above an empty "cuts per week" chart and a
 * top-services list missing most of its services.
 *
 * Everything now reads the same `ChairEvent` stream: every booking that actually
 * occupied the chair, whichever system it came from. Canceled time is excluded
 * (it was given back); a no-show is included (nobody else could book that hour).
 */

//  Periods

export type Bucket = "day" | "week" | "month";

/**
 * The page's one period control. Each period is a whole number of clean buckets
 * ending with the bucket containing today, so bar edges always land on real day
 * / Monday / 1st-of-month boundaries rather than mid-week.
 */
export const PERIODS = {
  "7d": { bucket: "day", count: 7, label: "Last 7 days", noun: "day" },
  "30d": { bucket: "day", count: 30, label: "Last 30 days", noun: "day" },
  "90d": { bucket: "week", count: 13, label: "Last 3 months", noun: "week" },
  "180d": { bucket: "week", count: 26, label: "Last 6 months", noun: "week" },
  "365d": { bucket: "month", count: 12, label: "Last 12 months", noun: "month" },
} as const satisfies Record<
  string,
  { bucket: Bucket; count: number; label: string; noun: string }
>;

export type PeriodKey = keyof typeof PERIODS;
/** A resolved window is either one of the presets or an explicit date range. */
export type WindowKey = PeriodKey | "custom";
export const PERIOD_KEYS = Object.keys(PERIODS) as PeriodKey[];
export const DEFAULT_PERIOD: PeriodKey = "30d";

/** Unknown/absent -> the default, so a stale client never gets a 400. */
export function resolvePeriod(raw: unknown): PeriodKey {
  return typeof raw === "string" && raw in PERIODS ? (raw as PeriodKey) : DEFAULT_PERIOD;
}

/** A shop-local YYYY-MM-DD as that day's UTC-midnight marker, or null. */
export function parseYmd(raw: unknown): Date | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Bar sizes that make sense for an explicit range of `days` days. */
export function customBucketOptions(days: number): Bucket[] {
  const out: Bucket[] = [];
  if (days <= 92) out.push("day"); // 92 day-bars is the readable ceiling
  if (days >= 14) out.push("week");
  if (days >= 60) out.push("month");
  return out.length > 0 ? out : ["day"];
}

/**
 * Which bucket sizes each period may be viewed at, and how many buckets that
 * makes. The default (PERIODS[key].bucket) is always present. Combinations
 * that can't render (365 day-bars in a hand-rolled div chart) or can't inform
 * (a 7-day window as one week bar) are simply absent - resolveBucket falls
 * back rather than 400ing, same forgiving contract as resolvePeriod.
 *
 * Non-default week/month views keep the "whole clean buckets ending with the
 * bucket containing today" rule, so their WINDOW can be slightly longer than
 * the period's name (30d by week = 5 Mon-start weeks = 35 days). The response
 * echoes windowStart/windowEnd, so the label never lies about it.
 */
export const BUCKET_COUNTS: Record<PeriodKey, Partial<Record<Bucket, number>>> = {
  "7d": { day: 7 },
  "30d": { day: 30, week: 5 },
  "90d": { day: 90, week: 13, month: 3 },
  "180d": { week: 26, month: 6 },
  "365d": { week: 52, month: 12 },
};

/** Unknown/absent/not-offered -> the period's default bucket. */
export function resolveBucket(key: PeriodKey, raw: unknown): Bucket {
  if (typeof raw === "string" && raw in BUCKET_COUNTS[key]) return raw as Bucket;
  return PERIODS[key].bucket;
}

export const DAY_MS = 86_400_000;
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

// Constructing an Intl.DateTimeFormat loads ICU data and is expensive; the day
// resolver is called once per chair event AND once per calendar day, so a busy
// shop over a year would build thousands of formatters and stall the single Node
// thread. Cache one per timezone (a handful of distinct zones across all shops).
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
 * An instant's calendar day in the shop's timezone, as that day's UTC midnight.
 * en-CA formats as YYYY-MM-DD, which we reinterpret as UTC so day/week math is
 * plain arithmetic. Bucketing MUST be shop-local: a Friday 11pm cut in New York
 * belongs to Friday, not to Saturday UTC.
 */
export function shopLocalDay(d: Date, timezone: string): Date {
  return new Date(`${dayFormatter(timezone).format(d)}T00:00:00Z`);
}

/** Monday 00:00 of the week containing `day` (a UTC-midnight shop-local day). */
export function weekStart(day: Date): Date {
  const dow = (day.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  return new Date(day.getTime() - dow * DAY_MS);
}

/**
 * A UTC-midnight day MARKER back into the real instant that day's local midnight
 * happened at.
 *
 * The two are not the same and mixing them costs a day at each end: the marker
 * for Aug 4 is 2026-08-04T00:00:00Z, which in New York is 8pm on Aug 3. Anything
 * that re-derives a local date from a marker (shopLocalDays does) must be handed
 * an instant, not the marker.
 */
export function localMidnightInstant(marker: Date, timezone: string): Date {
  return zonedWallTimeToUtc(
    marker.getUTCFullYear(),
    marker.getUTCMonth(),
    marker.getUTCDate(),
    0,
    timezone,
  );
}

/** Minutes elapsed since shop-local midnight at `now`. */
export function minutesIntoLocalDay(now: Date, timezone: string): number {
  const mins = Math.round((now.getTime() - shopLocalDay(now, timezone).getTime()) / 60_000);
  return Math.min(24 * 60, Math.max(0, mins));
}

export interface PeriodBucket {
  /** Stable key for React and for row lookups. */
  key: string;
  /** Short axis label ("Aug 4", "Jul 7", "Jul"). */
  label: string;
  /** Spelled-out label for tooltips ("Mon Aug 4", "Week of Jul 7", "July 2026"). */
  fullLabel: string;
  /** Shop-local day (UTC midnight) the bucket starts on, inclusive. */
  start: Date;
  /** Shop-local day (UTC midnight) the bucket ends on, EXCLUSIVE. */
  end: Date;
}

export interface ResolvedPeriod {
  key: WindowKey;
  bucket: Bucket;
  label: string;
  /** "day" | "week" | "month" - what one bar represents, for card titles. */
  noun: string;
  /** Shop-local first day of the window (UTC midnight), inclusive. */
  windowStart: Date;
  /**
   * The window's LAST day (UTC-midnight shop-local marker), inclusive. For a
   * preset that is today; for a custom range it is the chosen end date, which
   * may be in the past. Named `today` for history - every consumer treats it as
   * "the last day this window measures", and capacity stops there.
   */
  today: Date;
  buckets: PeriodBucket[];
  /** Which bar sizes this window offers (drives the Day/Week/Month pills). */
  bucketOptions: Bucket[];
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function shortDate(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * Turn a period key into concrete shop-local buckets ending with the bucket that
 * contains today. Day buckets are single days, week buckets are Mon-start weeks,
 * month buckets are calendar months.
 */
export function resolvePeriodWindow(
  now: Date,
  timezone: string,
  key: PeriodKey,
  bucketOverride?: Bucket,
): ResolvedPeriod {
  const spec = PERIODS[key];
  const bucket = bucketOverride ?? spec.bucket;
  // resolveBucket guarantees the pair exists; a direct caller passing a combo
  // that isn't offered gets the default count rather than NaN windows.
  const count = BUCKET_COUNTS[key][bucket] ?? spec.count;
  const today = shopLocalDay(now, timezone);
  const buckets: PeriodBucket[] = [];

  if (bucket === "day") {
    for (let i = count - 1; i >= 0; i--) {
      const start = new Date(today.getTime() - i * DAY_MS);
      buckets.push({
        key: start.toISOString().slice(0, 10),
        label: shortDate(start),
        fullLabel: `${WEEKDAYS[(start.getUTCDay() + 6) % 7]} ${shortDate(start)}`,
        start,
        end: new Date(start.getTime() + DAY_MS),
      });
    }
  } else if (bucket === "week") {
    const thisWeek = weekStart(today);
    for (let i = count - 1; i >= 0; i--) {
      const start = new Date(thisWeek.getTime() - i * 7 * DAY_MS);
      buckets.push({
        key: start.toISOString().slice(0, 10),
        label: shortDate(start),
        fullLabel: `Week of ${shortDate(start)}`,
        start,
        end: new Date(start.getTime() + 7 * DAY_MS),
      });
    }
  } else {
    const y = today.getUTCFullYear();
    const m = today.getUTCMonth();
    for (let i = count - 1; i >= 0; i--) {
      const start = new Date(Date.UTC(y, m - i, 1));
      buckets.push({
        key: start.toISOString().slice(0, 7),
        label: MONTHS[start.getUTCMonth()]!,
        fullLabel: `${start.toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        })}`,
        start,
        end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)),
      });
    }
  }

  return {
    key,
    bucket,
    label: spec.label,
    // The noun IS the bucket ("Cuts per day/week/month"), so a re-bucketed
    // view retitles itself and the label can't drift from the bars.
    noun: bucket,
    windowStart: buckets[0]!.start,
    today,
    buckets,
    bucketOptions: Object.keys(BUCKET_COUNTS[key]) as Bucket[],
  };
}

/**
 * An EXPLICIT date-to-date window ("Jun 1 - Jul 15"), shop-local and inclusive
 * of both ends.
 *
 * Unlike the presets, the bars here are clipped to exactly the range asked for:
 * a week bucket that straddles the start renders from the start date, not from
 * its Monday. Barbers pick a range because they mean THAT range (a promo, a
 * month they worked a booth), so silently widening it to clean bucket edges
 * would answer a different question than the one they asked.
 */
export function resolveCustomWindow(
  now: Date,
  timezone: string,
  fromDay: Date,
  toDay: Date,
  bucketOverride?: Bucket,
): ResolvedPeriod {
  const todayLocal = shopLocalDay(now, timezone);
  // Never measure the future: capacity and bookings both stop at today.
  const end = toDay.getTime() > todayLocal.getTime() ? todayLocal : toDay;
  const start = fromDay.getTime() > end.getTime() ? end : fromDay;
  const days = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  const options = customBucketOptions(days);
  const bucket = bucketOverride && options.includes(bucketOverride) ? bucketOverride : options[0]!;

  const buckets: PeriodBucket[] = [];
  if (bucket === "day") {
    for (let i = 0; i < days; i++) {
      const s = new Date(start.getTime() + i * DAY_MS);
      buckets.push({
        key: s.toISOString().slice(0, 10),
        label: shortDate(s),
        fullLabel: `${WEEKDAYS[(s.getUTCDay() + 6) % 7]} ${shortDate(s)}`,
        start: s,
        end: new Date(s.getTime() + DAY_MS),
      });
    }
  } else if (bucket === "week") {
    let s = weekStart(start);
    while (s.getTime() <= end.getTime()) {
      const rawEnd = new Date(s.getTime() + 7 * DAY_MS);
      // Clip the first and last buckets to the requested range.
      const bStart = s.getTime() < start.getTime() ? start : s;
      const bEnd = rawEnd.getTime() > end.getTime() + DAY_MS ? new Date(end.getTime() + DAY_MS) : rawEnd;
      buckets.push({
        key: bStart.toISOString().slice(0, 10),
        label: shortDate(bStart),
        fullLabel: `Week of ${shortDate(bStart)}`,
        start: bStart,
        end: bEnd,
      });
      s = rawEnd;
    }
  } else {
    let y = start.getUTCFullYear();
    let m = start.getUTCMonth();
    for (;;) {
      const rawStart = new Date(Date.UTC(y, m, 1));
      if (rawStart.getTime() > end.getTime()) break;
      const rawEnd = new Date(Date.UTC(y, m + 1, 1));
      const bStart = rawStart.getTime() < start.getTime() ? start : rawStart;
      const bEnd = rawEnd.getTime() > end.getTime() + DAY_MS ? new Date(end.getTime() + DAY_MS) : rawEnd;
      buckets.push({
        key: rawStart.toISOString().slice(0, 7),
        label: MONTHS[rawStart.getUTCMonth()]!,
        fullLabel: rawStart.toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }),
        start: bStart,
        end: bEnd,
      });
      m += 1;
      if (m > 11) {
        m = 0;
        y += 1;
      }
    }
  }

  const fmt = (d: Date) =>
    `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  return {
    key: "custom",
    bucket,
    label: `${fmt(start)} – ${fmt(end)}`,
    noun: bucket,
    windowStart: start,
    today: end,
    buckets,
    bucketOptions: options,
  };
}

/** Index of the bucket a shop-local day falls in, or -1 if outside the window. */
export function bucketIndexFor(period: ResolvedPeriod, localDay: Date): number {
  const t = localDay.getTime();
  if (t < period.windowStart.getTime()) return -1;
  const { bucket, buckets } = period;
  // A custom range clips its first/last bucket to the chosen dates, so the
  // uniform-width arithmetic below doesn't hold - walk instead (a custom
  // window is at most ~92 day-buckets).
  if (period.key === "custom" && bucket !== "day") {
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (t >= buckets[i]!.start.getTime()) {
        return t < buckets[i]!.end.getTime() ? i : -1;
      }
    }
    return -1;
  }
  // Day and week buckets are uniform, so index is arithmetic. Months vary in
  // length, so walk them (12 at most).
  //
  // 🔴 FLOOR, NOT ROUND. windowStart is buckets[0].start, so the quotient is
  // "how far into the series is this day" - and for WEEK buckets that is a
  // whole number only on the anchor day itself. Rounding sent days 4, 5 and 6
  // of every week (Fri/Sat/Sun on a Mon-start week) into the FOLLOWING bucket,
  // and in the newest week into index === buckets.length, which reads as
  // outside the window and dropped the day entirely.
  //
  // So the weekly cuts/revenue chart mis-attributed three days in seven and
  // silently lost the most recent Fri-Sun - the busiest part of a barber's
  // week. It hid because it only shows when data lands in the back half of a
  // bucket, which is also why the insights tests failed on a Monday and
  // passed on a Friday.
  if (bucket === "day") {
    const i = Math.floor((t - period.windowStart.getTime()) / DAY_MS);
    return i < buckets.length ? i : -1;
  }
  if (bucket === "week") {
    const i = Math.floor((t - period.windowStart.getTime()) / (7 * DAY_MS));
    return i < buckets.length ? i : -1;
  }
  for (let i = buckets.length - 1; i >= 0; i--) {
    if (t >= buckets[i]!.start.getTime()) {
      return t < buckets[i]!.end.getTime() ? i : -1;
    }
  }
  return -1;
}

//  Chair events

/**
 * One booking that occupied the chair, normalized across the systems it can come
 * from. `serviceId` is set only for native bookings (external systems send us a
 * free-text name), which is why service grouping keys on the id when it has one
 * and falls back to the trimmed name.
 */
export interface ChairEvent {
  start: Date;
  end: Date | null;
  /**
   * The TICKET this booking carried - what the cut is worth. Null = unpriced (a
   * manual walk-in), which is NOT the same as $0.
   *
   * This is the number that answers "what does a cut here go for", so it drives
   * average ticket. It is NOT revenue: a no-show carries a $40 ticket and earns
   * nothing. Use `earned` for money.
   */
  price: number | null;
  /**
   * Money actually EARNED by this booking - what revenue and every goal count.
   *
   * Where the shop takes payment through the app, this is real collected money
   * net of refunds, straight off the Payment row: a refunded booking earns 0,
   * a partly refunded one earns the remainder, and a cancellation fee kept on a
   * no-show earns exactly the fee. Where there is no payment record - a cash
   * shop, pay-direct, anything synced from Acuity or Square - it falls back to
   * the ticket, which is the best information that exists and is what every
   * card showed before.
   *
   * THE FALLBACK IS LOAD-BEARING. Reading only real payments would take every
   * cash shop's revenue to $0, so "no Payment row" must mean "trust the ticket",
   * never "earned nothing".
   */
  earned: number;
  /** True when the chair was held but no work was sold - a no-show. */
  noShow: boolean;
  serviceId: string | null;
  serviceName: string | null;
  /** Null for a walk-in booked without a client record. */
  clientId: string | null;
  source: "native" | "synced";
}

/**
 * Money in hand for one payment, in whole dollars, net of refunds.
 *
 * Mirrors the refund path's own arithmetic (billing/payments.ts): `collected`
 * is capturedAmount when set (hold mode captures a possibly-different amount)
 * else the authorized amount, and refunds come straight off it.
 *
 * Statuses that are still IN FLIGHT - authorized but uncaptured, processing,
 * awaiting action - have collected nothing yet, so they earn 0 and start
 * counting the moment the webhook marks them succeeded. `refunded` stays in the
 * list deliberately: it collected and then gave it all back, and the same
 * subtraction lands on exactly 0.
 */
const COLLECTED_STATUSES = new Set(["succeeded", "partially_refunded", "refunded"]);

function collectedDollars(p: {
  status: string;
  amount: number;
  capturedAmount: number | null;
  refundedAmount: number;
}): number {
  if (!COLLECTED_STATUSES.has(p.status)) return 0;
  const collected = p.capturedAmount ?? p.amount;
  return Math.max(0, collected - p.refundedAmount) / 100;
}

// A native booking that held the chair. PENDING (awaiting approval) and holds
// are provisional - they block a slot but were never sold, so they are not
// counted as work done. CANCELED is excluded by omission from both lists.
const NATIVE_STATUSES = ["BOOKED", "COMPLETED", "NO_SHOW"] as const;
const SYNCED_STATUSES = ["SCHEDULED", "RESCHEDULED", "COMPLETED", "NO_SHOW"] as const;

/**
 * Every chair event whose START instant lands in [from, to).
 *
 * `staffId` narrows to one barber's native bookings. External visits carry no
 * staff, so a staff-filtered read returns native rows ONLY - attributing an
 * Acuity visit to the selected barber would invent work he may not have done.
 * Callers surface that caveat via the returned `syncedExcluded` flag.
 */
export async function readChairEvents(
  shopId: string,
  from: Date,
  to: Date,
  opts: { staffId?: string; tx?: Prisma.TransactionClient } = {},
): Promise<{ events: ChairEvent[]; syncedExcluded: boolean }> {
  const { staffId } = opts;
  // Appointment and Visit are ENABLE+FORCE RLS tables (tenant_isolation checks
  // app.current_shop_id): a bare prisma read returns ZERO rows under an
  // enforcing role, so the reads run inside a shop-scoped transaction. Every
  // transaction is real latency (BEGIN + SET ROLE + set_config + COMMIT are
  // each a DB round trip), so callers that already hold a runWithShop tx pass
  // it in and this becomes two plain queries on the caller's transaction -
  // one tx per REQUEST, not per read. The explicit shopId in each where stays
  // as the app-layer half of the two-layer isolation.
  const run = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
    opts.tx ? fn(opts.tx) : runWithShop(shopId, fn);
  const { appts, visits } = await run(async (tx) => ({
    appts: await tx.appointment.findMany({
      where: {
        shopId,
        ...(staffId ? { staffId } : {}),
        holdExpiresAt: null,
        status: { in: [...NATIVE_STATUSES] },
        startsAt: { gte: from, lt: to },
      },
      select: {
        startsAt: true,
        endsAt: true,
        priceAtBooking: true,
        status: true,
        clientId: true,
        serviceId: true,
        // What the barber actually collected at the chair. Overrides the
        // ticket when set - see `earned` below.
        paidAmount: true,
        service: { select: { name: true } },
        // Real money, when the shop takes payment through the app. Null for
        // every cash / pay-direct shop, which is why `earned` falls back to
        // the ticket rather than to zero.
        payment: {
          select: {
            status: true,
            amount: true,
            capturedAmount: true,
            refundedAmount: true,
          },
        },
      },
    }),
    // `appointment: null` keeps a Visit that was promoted FROM a native
    // appointment from double-counting the same hour - the appointment row
    // above already represents it.
    visits: staffId
      ? []
      : await tx.visit.findMany({
          where: {
            shopId,
            appointment: null,
            status: { in: [...SYNCED_STATUSES] },
            scheduledAt: { gte: from, lt: to },
          },
          select: {
            scheduledAt: true,
            endAt: true,
            price: true,
            status: true,
            clientId: true,
            serviceName: true,
          },
        }),
  }));

  const events: ChairEvent[] = [];
  for (const a of appts) {
    const ticket = a.priceAtBooking === null ? null : Number(a.priceAtBooking);
    const noShow = a.status === "NO_SHOW";
    events.push({
      start: a.startsAt,
      end: a.endsAt,
      price: ticket,
      // Real money wins wherever it exists - it already accounts for refunds,
      // for a partial capture, and for a fee kept on a no-show. With no payment
      // record we trust the ticket, EXCEPT on a no-show: nobody sat in the
      // chair and no cash changed hands, so the shop earned nothing.
      // Chair-side checkout is the barber's own final word on what he took,
      // so once a cut is checked out that figure IS the revenue (plus anything
      // Stripe already collected - the two never overlap by construction).
      // Falling back to the ticket only for cuts never checked out keeps every
      // cash shop, which is most of them, from reading $0.
      earned:
        a.paidAmount != null
          ? Number(a.paidAmount) + (a.payment ? collectedDollars(a.payment) : 0)
          : a.payment
            ? collectedDollars(a.payment)
            : noShow
              ? 0
              : (ticket ?? 0),
      noShow,
      serviceId: a.serviceId,
      serviceName: a.service?.name ?? null,
      clientId: a.clientId,
      source: "native",
    });
  }
  for (const v of visits) {
    const ticket = v.price === null ? null : Number(v.price);
    // Synced systems never send us a payment, so the ticket is all we have.
    const noShow = v.status === "NO_SHOW";
    events.push({
      start: v.scheduledAt,
      end: v.endAt,
      price: ticket,
      earned: noShow ? 0 : (ticket ?? 0),
      noShow,
      serviceId: null,
      serviceName: v.serviceName,
      clientId: v.clientId,
      source: "synced",
    });
  }
  return { events, syncedExcluded: Boolean(staffId) };
}

/** Group key for a service: the real id when we have one, else its trimmed name. */
export function serviceKey(e: {
  serviceId: string | null;
  serviceName: string | null;
}): string {
  if (e.serviceId) return `id:${e.serviceId}`;
  const name = e.serviceName?.trim();
  return name ? `name:${name.toLowerCase()}` : "none";
}

/** The label a service group shows. Unnamed external bookings say so honestly. */
export function serviceLabel(e: { serviceName: string | null }): string {
  return e.serviceName?.trim() || "(no service name)";
}
