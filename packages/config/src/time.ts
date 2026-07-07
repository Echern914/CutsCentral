/**
 * Pure time/stat helpers used by the cadence engine. No I/O, no Date.now() -
 * callers pass timestamps in, so these stay deterministic and unit-testable.
 */

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** Whole-day difference between two dates (later - earlier), rounded. */
export function dayDiff(earlier: Date, later: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / MS_PER_DAY);
}

/**
 * Gaps in days between consecutive dates. Input is sorted ascending first, so
 * callers don't have to pre-sort. Returns [] for fewer than 2 dates.
 */
export function dayGaps(dates: Date[]): number[] {
  if (dates.length < 2) return [];
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(dayDiff(sorted[i - 1]!, sorted[i]!));
  }
  return gaps;
}

/**
 * Median of a list of numbers. Median (not mean) resists outliers - a client
 * with one freak 90-day gap shouldn't skew their cadence. Returns null for [].
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Add whole days to a date, returning a new Date. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/**
 * The wall-clock hour (0-23) at instant `at` in the given IANA timezone.
 * Uses Intl (built into Node) so we get correct DST-aware local time with no
 * dependency and no hand-rolled offset table. Falls back to UTC if the runtime
 * rejects the timezone string (never throws - a bad tz must not crash a send).
 */
export function hourInTimeZone(at: Date, timeZone: string): number {
  let hourStr: string;
  try {
    hourStr = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      hour12: false,
    }).format(at);
  } catch {
    // Invalid IANA name => format throws a RangeError. Fall back to UTC hour.
    return at.getUTCHours();
  }
  // hour12:false can emit "24" for midnight on some engines; normalize to 0-23.
  const hour = parseInt(hourStr, 10) % 24;
  return Number.isNaN(hour) ? at.getUTCHours() : hour;
}

/**
 * Minutes-from-local-midnight (0-1439) of instant `at` in `timeZone`. The
 * shop-local wall-clock time-of-day, DST-aware. Used to snapshot a recurring
 * series' pattern (weekday + startMin) from its anchor appointment so occurrences
 * recompute at the same local time across DST via zonedWallTimeToUtc.
 */
export function localMinutesOfDay(at: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at);
    const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10) % 24;
    const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
    if (Number.isNaN(h) || Number.isNaN(m)) return 0;
    return h * 60 + m;
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  }
}

/**
 * Is `at` within TCPA quiet hours (i.e. NOT allowed to send) for a recipient in
 * `timeZone`? Allowed window is [startHour, endHour); anything outside is quiet.
 * Handles a window that does not wrap (8..21): quiet when hour < start or
 * hour >= end.
 */
export function isQuietHours(
  at: Date,
  timeZone: string,
  startHour: number,
  endHour: number,
): boolean {
  const hour = hourInTimeZone(at, timeZone);
  return hour < startHour || hour >= endHour;
}

/**
 * The UTC offset (in minutes, e.g. -240 for EDT) of `timeZone` at instant `at`.
 * Computed via Intl by reading the same instant rendered in the zone and in UTC,
 * so it is DST-aware with no offset table. Falls back to 0 (UTC) on a bad zone.
 */
function tzOffsetMinutes(at: Date, timeZone: string): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = dtf.formatToParts(at);
    const get = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value);
    let hour = get("hour");
    if (hour === 24) hour = 0; // some engines emit 24 for midnight
    // The wall-clock the zone shows for this instant, read as if it were UTC.
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      hour,
      get("minute"),
      get("second"),
    );
    return Math.round((asUtc - at.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/**
 * Convert a LOCAL wall-clock time in `timeZone` to the corresponding UTC instant.
 * The local time is given as a calendar date (year/month0/day) plus minutes from
 * local midnight. DST-correct: the offset is resolved at the target instant
 * itself (two-pass, since the offset can depend on the date we're computing).
 *
 * Used by the slot engine so a stored "9:00am" availability rule maps to the
 * right UTC instant on both sides of a daylight-saving transition. (Around the
 * 1-hour DST gap/overlap the mapping is approximate by at most an hour, which is
 * acceptable for appointment slots and never produces an invalid Date.)
 */
export function zonedWallTimeToUtc(
  year: number,
  month0: number,
  day: number,
  minutesFromMidnight: number,
  timeZone: string,
): Date {
  const hour = Math.floor(minutesFromMidnight / 60);
  const minute = minutesFromMidnight % 60;
  // First guess: treat the wall time as if it were UTC, then correct by the
  // offset at that guessed instant. A second pass handles the rare case where
  // the offset differs between the guess and the corrected instant (DST edges).
  const guess = Date.UTC(year, month0, day, hour, minute, 0);
  const offset1 = tzOffsetMinutes(new Date(guess), timeZone);
  const corrected = guess - offset1 * 60000;
  const offset2 = tzOffsetMinutes(new Date(corrected), timeZone);
  if (offset2 === offset1) return new Date(corrected);
  return new Date(guess - offset2 * 60000);
}

/** The shop-local calendar parts (year, month0 0-11, day, weekday 0-6) at `at`. */
export function zonedDateParts(
  at: Date,
  timeZone: string,
): { year: number; month0: number; day: number; weekday: number } {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    });
    const parts = dtf.formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    const weekdayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    return {
      year: Number(get("year")),
      month0: Number(get("month")) - 1,
      day: Number(get("day")),
      weekday: weekdayMap[get("weekday") ?? "Sun"] ?? 0,
    };
  } catch {
    return {
      year: at.getUTCFullYear(),
      month0: at.getUTCMonth(),
      day: at.getUTCDate(),
      weekday: at.getUTCDay(),
    };
  }
}
