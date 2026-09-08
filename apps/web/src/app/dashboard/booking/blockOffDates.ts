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
  | { kind: "days"; fromDate: string; toDate: string }
  | { kind: "timed"; date: string; fromTime: string; toTime: string };

/**
 * The line under the form: what will be blocked, in the barber's words.
 *   "September 9–16 · All day · 8 days"
 *   "Tuesday, September 9 · All day"
 *   "Tuesday, September 9 · 2:00 PM–5:00 PM"
 * Says nothing about a plan it cannot describe (a bad date, an empty time),
 * so the caller's validation message is the only thing the barber reads.
 */
export function blockSummary(plan: BlockPlan, todayKey: string): string {
  if (plan.kind === "days") {
    const n = dayCount(plan.fromDate, plan.toDate);
    if (n === 0) return "";
    const when = formatDayRange(plan.fromDate, plan.toDate, todayKey);
    return n === 1 ? `${when} · All day` : `${when} · All day · ${n} days`;
  }
  if (!isDayKey(plan.date)) return "";
  const from = formatClock(plan.fromTime);
  const to = formatClock(plan.toTime);
  if (!from || !to) return "";
  return `${formatDay(plan.date, todayKey)} · ${from}–${to}`;
}
