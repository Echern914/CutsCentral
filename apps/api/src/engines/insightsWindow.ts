import { prisma } from "@chairback/db";
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
export const PERIOD_KEYS = Object.keys(PERIODS) as PeriodKey[];
export const DEFAULT_PERIOD: PeriodKey = "30d";

/** Unknown/absent -> the default, so a stale client never gets a 400. */
export function resolvePeriod(raw: unknown): PeriodKey {
  return typeof raw === "string" && raw in PERIODS ? (raw as PeriodKey) : DEFAULT_PERIOD;
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
  key: PeriodKey;
  bucket: Bucket;
  label: string;
  /** "day" | "week" | "month" - what one bar represents, for card titles. */
  noun: string;
  /** Shop-local first day of the window (UTC midnight), inclusive. */
  windowStart: Date;
  /** Shop-local today (UTC midnight). The window ends at `now`, inside it. */
  today: Date;
  buckets: PeriodBucket[];
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
): ResolvedPeriod {
  const spec = PERIODS[key];
  const today = shopLocalDay(now, timezone);
  const buckets: PeriodBucket[] = [];

  if (spec.bucket === "day") {
    for (let i = spec.count - 1; i >= 0; i--) {
      const start = new Date(today.getTime() - i * DAY_MS);
      buckets.push({
        key: start.toISOString().slice(0, 10),
        label: shortDate(start),
        fullLabel: `${WEEKDAYS[(start.getUTCDay() + 6) % 7]} ${shortDate(start)}`,
        start,
        end: new Date(start.getTime() + DAY_MS),
      });
    }
  } else if (spec.bucket === "week") {
    const thisWeek = weekStart(today);
    for (let i = spec.count - 1; i >= 0; i--) {
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
    for (let i = spec.count - 1; i >= 0; i--) {
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
    bucket: spec.bucket,
    label: spec.label,
    noun: spec.noun,
    windowStart: buckets[0]!.start,
    today,
    buckets,
  };
}

/** Index of the bucket a shop-local day falls in, or -1 if outside the window. */
export function bucketIndexFor(period: ResolvedPeriod, localDay: Date): number {
  const t = localDay.getTime();
  if (t < period.windowStart.getTime()) return -1;
  const { bucket, buckets } = period;
  // Day and week buckets are uniform, so index is arithmetic. Months vary in
  // length, so walk them (12 at most).
  if (bucket === "day") {
    const i = Math.round((t - period.windowStart.getTime()) / DAY_MS);
    return i < buckets.length ? i : -1;
  }
  if (bucket === "week") {
    const i = Math.round((t - period.windowStart.getTime()) / (7 * DAY_MS));
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
  /** Null = unpriced (a manual walk-in), which is NOT the same as $0. */
  price: number | null;
  serviceId: string | null;
  serviceName: string | null;
  /** Null for a walk-in booked without a client record. */
  clientId: string | null;
  source: "native" | "synced";
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
  opts: { staffId?: string } = {},
): Promise<{ events: ChairEvent[]; syncedExcluded: boolean }> {
  const { staffId } = opts;
  const [appts, visits] = await Promise.all([
    prisma.appointment.findMany({
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
        clientId: true,
        serviceId: true,
        service: { select: { name: true } },
      },
    }),
    // `appointment: null` keeps a Visit that was promoted FROM a native
    // appointment from double-counting the same hour - the appointment row above
    // already represents it.
    staffId
      ? Promise.resolve([])
      : prisma.visit.findMany({
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
            clientId: true,
            serviceName: true,
          },
        }),
  ]);

  const events: ChairEvent[] = [];
  for (const a of appts) {
    events.push({
      start: a.startsAt,
      end: a.endsAt,
      price: a.priceAtBooking === null ? null : Number(a.priceAtBooking),
      serviceId: a.serviceId,
      serviceName: a.service?.name ?? null,
      clientId: a.clientId,
      source: "native",
    });
  }
  for (const v of visits) {
    events.push({
      start: v.scheduledAt,
      end: v.endAt,
      price: v.price === null ? null : Number(v.price),
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
