/**
 * Day-key arithmetic and the sentence the Block-off form shows before saving.
 *
 * Everything here works on "YYYY-MM-DD" keys in the SHOP's calendar and never
 * on the device's local clock: a key is formatted by pinning it to noon UTC
 * and rendering in UTC, so "2026-09-09" reads as September 9 on a phone in
 * any zone. Pure and browser-safe - the form and its tests both import it.
 */

/** A vacation is a year at most. Mirrors the API's MAX_BLOCK_DAYS. */
export const MAX_BLOCK_DAYS = 366;

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60_000;

/** True for a real calendar date in key form ("2026-02-30" is not one). */
export function isDayKey(key: string): boolean {
  return utcNoonOf(key) !== null;
}

/** The key pinned to noon UTC, or null when it is not a real date. */
function utcNoonOf(key: string): Date | null {
  const m = DAY_KEY_RE.exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  const m0 = Number(m[2]) - 1;
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, m0, d, 12));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m0 || probe.getUTCDate() !== d) {
    return null;
  }
  return probe;
}

function keyOf(at: Date): string {
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(at.getUTCDate()).padStart(2, "0");
  return `${at.getUTCFullYear()}-${mm}-${dd}`;
}

/** The key `days` days after `key` (negative moves back). Invalid in, "" out. */
export function addDaysToKey(key: string, days: number): string {
  const at = utcNoonOf(key);
  if (!at) return "";
  return keyOf(new Date(at.getTime() + days * DAY_MS));
}

/**
 * Days in [from, to], inclusive. 0 when either key is invalid or `to` is
 * before `from` - the form treats 0 as "nothing to block" and refuses.
 */
export function dayCount(from: string, to: string): number {
  const a = utcNoonOf(from);
  const b = utcNoonOf(to);
  if (!a || !b || b.getTime() < a.getTime()) return 0;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS) + 1;
}

const MONTH_DAY = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});
const MONTH_DAY_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const WEEKDAY_MONTH_DAY = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});
const DAY_ONLY = new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: "UTC" });

/**
 * "Tuesday, September 9", with the year appended when it is not this year -
 * a day off next January should say so.
 */
export function formatDay(key: string, todayKey: string): string {
  const at = utcNoonOf(key);
  if (!at) return key;
  const base = WEEKDAY_MONTH_DAY.format(at);
  return key.slice(0, 4) === todayKey.slice(0, 4) ? base : `${base}, ${key.slice(0, 4)}`;
}

/**
 * The range as people write it:
 *   same month  -> "September 9–16"
 *   same year   -> "September 29 – October 2"
 *   otherwise   -> "December 30, 2026 – January 2, 2027"
 * plus the year on a same-year range that is not THIS year. A one-day range
 * is just the day.
 */
export function formatDayRange(from: string, to: string, todayKey: string): string {
  const a = utcNoonOf(from);
  const b = utcNoonOf(to);
  if (!a || !b) return `${from} – ${to}`;
  if (from === to) return formatDay(from, todayKey).replace(/^[A-Za-z]+, /, "");
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const thisYear = sameYear && from.slice(0, 4) === todayKey.slice(0, 4);
  if (!sameYear) return `${MONTH_DAY_YEAR.format(a)} – ${MONTH_DAY_YEAR.format(b)}`;
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  const range = sameMonth
    ? `${MONTH_DAY.format(a)}–${DAY_ONLY.format(b)}`
    : `${MONTH_DAY.format(a)} – ${MONTH_DAY.format(b)}`;
  return thisYear ? range : `${range}, ${from.slice(0, 4)}`;
}

const CLOCK = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

/** "14:00" -> "2:00 PM". A cleared input ("") comes back as "". */
export function formatClock(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return "";
  return CLOCK.format(new Date(Date.UTC(2000, 0, 1, Number(m[1]), Number(m[2]))));
}

/** "HH:mm" -> minutes from midnight; NaN for a cleared input. */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

export type BlockPlan =
  | {
      kind: "days";
      fromDate: string;
      toDate: string;
      /** The same hours on each day; absent = all day on each. */
      window?: { fromTime: string; toTime: string };
    }
  | { kind: "timed"; date: string; fromTime: string; toTime: string }
  /** One unbroken absence: fromTime on fromDate straight through toTime on toDate. */
  | { kind: "through"; fromDate: string; fromTime: string; toDate: string; toTime: string }
  /** The same block on `date` and the same weekday after it, `weeks` times. */
  | { kind: "weekly"; date: string; weeks: number; window?: { fromTime: string; toTime: string } };

/** The longest weekly repeat. Mirrors the API's MAX_REPEAT_WEEKS. */
export const MAX_REPEAT_WEEKS = 52;

/**
 * How many weeks a repeat "until" a date covers, inclusive of a last
 * occurrence that lands ON that date. 0 when the dates are broken or inverted.
 */
export function weeksThrough(fromDate: string, untilDate: string): number {
  const n = dayCount(fromDate, untilDate);
  return n === 0 ? 0 : Math.floor((n - 1) / 7) + 1;
}

/** The shop-local days a plan touches, in order - what the review lists. */
export function planDays(plan: BlockPlan): string[] {
  if (plan.kind === "timed") return isDayKey(plan.date) ? [plan.date] : [];
  if (plan.kind === "weekly") {
    if (!isDayKey(plan.date) || !(plan.weeks >= 1)) return [];
    return Array.from({ length: Math.min(plan.weeks, MAX_REPEAT_WEEKS) }, (_, k) =>
      addDaysToKey(plan.date, 7 * k),
    );
  }
  const n = dayCount(plan.fromDate, plan.toDate);
  return Array.from({ length: Math.min(n, MAX_BLOCK_DAYS) }, (_, k) => addDaysToKey(plan.fromDate, k));
}

const SHORT_DAY = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** "Mon, Oct 26" - a review list entry. */
export function formatShortDay(key: string): string {
  const at = utcNoonOf(key);
  return at ? SHORT_DAY.format(at) : key;
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" });

/**
 * The line under the form: what will be blocked, in the barber's words.
 *   "September 9–16 · All day · 8 days"
 *   "September 9–16 · 9:00 AM–12:00 PM each day · 8 days"
 *   "Tuesday, September 9 · All day"
 *   "Tuesday, September 9 · 2:00 PM–5:00 PM"
 * Says nothing about a plan it cannot describe (a bad date, an empty time),
 * so the caller's validation message is the only thing the barber reads.
 */
export function blockSummary(plan: BlockPlan, todayKey: string): string {
  if (plan.kind === "through") {
    // One absence, said as one: where it starts and where it ends.
    if (dayCount(plan.fromDate, plan.toDate) === 0) return "";
    const from = formatClock(plan.fromTime);
    const to = formatClock(plan.toTime);
    if (!from || !to) return "";
    return `${formatDay(plan.fromDate, todayKey)}, ${from} straight through ${formatDay(plan.toDate, todayKey)}, ${to}`;
  }
  if (plan.kind === "weekly") {
    const days = planDays(plan);
    if (days.length === 0) return "";
    const at = utcNoonOf(plan.date)!;
    let hours = "All day";
    if (plan.window) {
      const from = formatClock(plan.window.fromTime);
      const to = formatClock(plan.window.toTime);
      if (!from || !to) return "";
      hours = `${from}–${to}`;
    }
    const n = days.length;
    const span = formatDayRange(days[0]!, days[n - 1]!, todayKey);
    return n === 1
      ? `${formatDay(plan.date, todayKey)} · ${hours}`
      : `Every ${WEEKDAY.format(at)} · ${hours} · ${n} weeks, ${span}`;
  }
  if (plan.kind === "days") {
    const n = dayCount(plan.fromDate, plan.toDate);
    if (n === 0) return "";
    const when = formatDayRange(plan.fromDate, plan.toDate, todayKey);
    let hours = "All day";
    if (plan.window) {
      const from = formatClock(plan.window.fromTime);
      const to = formatClock(plan.window.toTime);
      if (!from || !to) return "";
      hours = n === 1 ? `${from}–${to}` : `${from}–${to} each day`;
    }
    return n === 1 ? `${when} · ${hours}` : `${when} · ${hours} · ${n} days`;
  }
  if (!isDayKey(plan.date)) return "";
  const from = formatClock(plan.fromTime);
  const to = formatClock(plan.toTime);
  if (!from || !to) return "";
  return `${formatDay(plan.date, todayKey)} · ${from}–${to}`;
}
