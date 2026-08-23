/**
 * Waitlist preferences, as structure instead of prose.
 *
 * Before this, a customer typed "Sat morning" into a free-text box and a human
 * read it. That is unmatchable: PR D has to ask "does this freed 10:15 slot fit
 * anyone", and no amount of parsing makes "whenever really" answerable.
 *
 * 🔑 NULL MEANS ANY, on each half independently. A window is a date part and a
 * time part, and either can be absent:
 *
 *     any date  + any time   ->  the 118 backfilled rows from PR A
 *     one date  + any time   ->  "Saturday, whenever"
 *     a range   + 09:00-12:00 ->  "mornings, next two weeks"
 *
 * Keeping the two halves independent is what let PR A migrate every existing
 * entry into exactly one window that behaves precisely as it did before.
 *
 * Everything here is pure. The route validates, then writes; the matcher in
 * PR D reads the same shapes back.
 */

/** How many preference windows one entry may carry. */
export const MAX_WINDOWS = 5;

/**
 * How far ahead "any date" reaches, in days. A standing entry with no end
 * would sit in the queue forever and be offered a slot months later, which
 * reads as spam rather than service.
 */
export const ANY_DATE_HORIZON_DAYS = 14;

/** Minutes in a day. An end of exactly 1440 means "to midnight". */
const MINUTES_PER_DAY = 1440;

/** A validated window, in the exact shape WaitlistWindow stores. */
export interface WaitlistWindowInput {
  /** Shop-local "YYYY-MM-DD". Null = any date. */
  startDate: string | null;
  endDate: string | null;
  /** Minutes from shop-local midnight, end exclusive. Null = any time. */
  startMin: number | null;
  endMin: number | null;
}

export interface WindowError {
  /** Stable machine code; the UI maps it to copy. */
  code:
    | "too_many_windows"
    | "no_windows"
    | "bad_date"
    | "date_out_of_range"
    | "date_backwards"
    | "half_open_date"
    | "bad_time"
    | "time_backwards"
    | "half_open_time";
  /** Which window tripped it, 0-based. -1 for list-level problems. */
  index: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is this a real calendar date, not just four-two-two digits? Rejects
 * 2026-02-30 and 2026-13-01, which the regex alone waves through and which
 * would then sort correctly and match nothing forever.
 */
export function isCalendarDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  // Day 0 of the next month is the last day of this one. UTC throughout: these
  // are calendar labels, never instants, so no timezone enters here.
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= last;
}

/** Shop-local "YYYY-MM-DD" for an instant, given the shop's IANA zone. */
export function shopLocalDate(at: Date, timezone: string): string {
  // en-CA formats as YYYY-MM-DD, which is the whole reason it is used here.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** `days` calendar days after a shop-local date, as another "YYYY-MM-DD". */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/**
 * Validate one window. Returns the error code, or null if it is sound.
 *
 * `today` is the shop-local date the horizon is measured from, passed in
 * rather than read off the clock so this stays pure and the tests cannot
 * flake on the hour they run.
 */
export function validateWindow(
  w: WaitlistWindowInput,
  today: string,
): WindowError["code"] | null {
  const { startDate, endDate, startMin, endMin } = w;

  // ---- dates ----
  if (startDate !== null || endDate !== null) {
    // Half-set is not "open-ended", it is a bug that would silently match a
    // year: "from Saturday until whenever" is not something the UI can offer.
    if (startDate === null || endDate === null) return "half_open_date";
    if (!isCalendarDate(startDate) || !isCalendarDate(endDate)) return "bad_date";
    if (startDate > endDate) return "date_backwards";
    // Past dates and dates beyond the horizon can never be matched, so taking
    // them would be a promise nothing can keep.
    const horizon = addDays(today, ANY_DATE_HORIZON_DAYS);
    if (endDate < today || startDate > horizon) return "date_out_of_range";
  }

  // ---- times ----
  if (startMin !== null || endMin !== null) {
    if (startMin === null || endMin === null) return "half_open_time";
    if (!Number.isInteger(startMin) || !Number.isInteger(endMin)) return "bad_time";
    if (startMin < 0 || endMin > MINUTES_PER_DAY) return "bad_time";
    // End-exclusive, so equal start and end is an empty window, not a moment.
    if (startMin >= endMin) return "time_backwards";
  }

  return null;
}

/**
 * Validate the whole list. Returns the first error, or null.
 *
 * An empty list is rejected rather than silently treated as "any / any": the
 * form always sends at least one window, so an empty list means something
 * upstream dropped it, and inventing a preference for a customer is worse
 * than a 400.
 */
export function validateWindows(
  windows: WaitlistWindowInput[],
  today: string,
): WindowError | null {
  if (windows.length === 0) return { code: "no_windows", index: -1 };
  if (windows.length > MAX_WINDOWS) return { code: "too_many_windows", index: -1 };
  for (const [index, w] of windows.entries()) {
    const code = validateWindow(w, today);
    if (code) return { code, index };
  }
  return null;
}

/** The single "Any date / Any time" window - what PR A backfilled 118 of. */
export const ANY_WINDOW: WaitlistWindowInput = {
  startDate: null,
  endDate: null,
  startMin: null,
  endMin: null,
};

/**
 * A stable fingerprint of an entry's preferences, for duplicate detection.
 *
 * 🔑 ORDER MUST NOT MATTER. Someone who picks Saturday then Sunday has asked
 * for the same thing as someone who picks Sunday then Saturday, and letting
 * the two coexist would put one person in the queue twice and offer them the
 * same freed slot two ways. Sorting the parts before joining is what makes
 * "same preferences" a fact rather than a guess about form order.
 *
 * Exact duplicate windows collapse too - asking for Saturday twice is asking
 * for Saturday.
 */
export function windowsFingerprint(windows: WaitlistWindowInput[]): string {
  const parts = windows.map(
    (w) =>
      `${w.startDate ?? "*"}..${w.endDate ?? "*"}@${w.startMin ?? "*"}-${w.endMin ?? "*"}`,
  );
  return [...new Set(parts)].sort().join("|");
}

/**
 * Is this a supported IANA zone on THIS runtime?
 *
 * Asked rather than pattern-matched: the tz database moves, and the only
 * authority that matters is the Intl implementation that will later format
 * times with it. A zone that parses here is one the matcher can use.
 */
export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
