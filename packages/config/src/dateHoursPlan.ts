import { openingSpansForWeekday, parseServiceHours } from "./servicePricing.js";

/**
 * "CHANGE SOME DAYS" - the words and the arithmetic of a service's per-date
 * hours, in one place.
 *
 * The dashboard sheet reads a change back to the barber as a sentence before
 * saving ("Mon Nov 23, Tue 24 and Wed 25: Haircut is open 8:00 AM - 3:30 PM
 * and 4:30 - 8:00 PM, at the usual price.") and shows what it adds to each
 * day. Both live here rather than inside the sheet so any other surface that
 * has to say the same thing - a list of special dates, a help answer - says it
 * with the same function, and cannot drift.
 *
 * Pure (no Node APIs, no Intl): import by SUBPATH from client components -
 * `@chairback/config/dateHoursPlan`.
 *
 * What an entry MEANS is not decided here. That is engines/slots.ts in the
 * API: a dated entry replaces the service's day. `usualSpans` below restates
 * the engine's weekly rule only to DRAW the comparison; it decides nothing.
 */

/** Shop-local minutes from midnight, end exclusive. */
export interface Span {
  startMin: number;
  endMin: number;
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "HH:MM" (24h; "24:00" is the end of the day) to a minute of day, or null. */
export function hhmmToMinute(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

/** A minute of day back to "HH:MM" ("24:00" for the end of the day). */
export function minuteToHhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** "8:00 AM", "3:30 PM"; the end of the day reads "midnight", not "12:00 AM". */
export function clockLabel(min: number): string {
  if (min === 1440) return "midnight";
  const h = Math.floor(min / 60);
  const m = min % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "8:00 AM - 3:30 PM" with an en dash. */
export function spanLabel(span: Span): string {
  return `${clockLabel(span.startMin)} – ${clockLabel(span.endMin)}`;
}

/** "8:00 AM - 3:30 PM and 4:30 PM - 8:00 PM"; "" for none. */
export function spansLabel(spans: readonly Span[]): string {
  return joinWithAnd(spans.map(spanLabel));
}

function joinWithAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Sorted, with spans that touch or overlap joined. */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = spans
    .filter((s) => s.endMin > s.startMin)
    .map((s) => ({ ...s }))
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.startMin <= last.endMin) {
      if (s.endMin > last.endMin) last.endMin = s.endMin;
    } else out.push(s);
  }
  return out;
}

/**
 * Why a set of hours cannot be saved as typed, or null.
 *
 *  - "ends_before_start": a row ends at or before it starts;
 *  - "overlap": two rows share time. Rows that merely TOUCH are fine (the
 *    server stores them as one), so 8-12 and 12-4 is not a problem.
 *
 * The server refuses the same two things (services/serviceDateHours.ts); this
 * exists so the sheet can say which, on the row, before the round trip.
 */
export function dateHoursProblem(spans: readonly Span[]): "ends_before_start" | "overlap" | null {
  if (spans.some((s) => s.endMin <= s.startMin)) return "ends_before_start";
  const sorted = [...spans].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.startMin < sorted[i - 1]!.endMin) return "overlap";
  }
  return null;
}

/**
 * What one staff member's day normally is for a service on a weekday - the
 * weekly rule the slot engine applies (engines/slots.ts), restated for the
 * comparison bars only:
 *   staff hours, narrowed to the service's weekly hours where it has any for
 *   that weekday (present and empty = not offered), plus any window the
 *   service explicitly opens.
 */
export function usualSpans(input: {
  weekday: number;
  staffRules: readonly { weekday: number; startMin: number; endMin: number }[];
  hoursWindows: unknown;
  timeOverrides: unknown;
}): Span[] {
  const { weekday } = input;
  const rules = input.staffRules.filter((r) => r.weekday === weekday && r.endMin > r.startMin);
  const byWeekday = parseServiceHours(input.hoursWindows);
  const spans: Span[] = [];
  if (!byWeekday.has(weekday)) {
    for (const r of rules) spans.push({ startMin: r.startMin, endMin: r.endMin });
  } else {
    for (const r of rules) {
      for (const a of byWeekday.get(weekday)!) {
        const s = Math.max(r.startMin, a.startMin);
        const e = Math.min(r.endMin, a.endMin);
        if (e > s) spans.push({ startMin: s, endMin: e });
      }
    }
  }
  spans.push(...openingSpansForWeekday(input.timeOverrides, weekday));
  return mergeSpans(spans);
}

function minutesIn(spans: readonly Span[]): number {
  return mergeSpans(spans).reduce((n, s) => n + (s.endMin - s.startMin), 0);
}

function minutesShared(a: readonly Span[], b: readonly Span[]): number {
  let total = 0;
  for (const x of mergeSpans(a)) {
    for (const y of mergeSpans(b)) {
      total += Math.max(0, Math.min(x.endMin, y.endMin) - Math.max(x.startMin, y.startMin));
    }
  }
  return total;
}

/** Minutes the new hours open that the usual day does not, and take away. */
export function hoursDelta(usual: readonly Span[], next: readonly Span[]): { addedMin: number; removedMin: number } {
  const shared = minutesShared(usual, next);
  return { addedMin: minutesIn(next) - shared, removedMin: minutesIn(usual) - shared };
}

/**
 * A day's comparison, cut into the three things the bar draws: time that was
 * open and still is, time the change opens, and time it takes away.
 */
export function compareSpans(
  usual: readonly Span[],
  next: readonly Span[],
): { kept: Span[]; added: Span[]; removed: Span[] } {
  const u = mergeSpans(usual);
  const n = mergeSpans(next);
  const kept: Span[] = [];
  for (const x of u) {
    for (const y of n) {
      const s = Math.max(x.startMin, y.startMin);
      const e = Math.min(x.endMin, y.endMin);
      if (e > s) kept.push({ startMin: s, endMin: e });
    }
  }
  const minus = (from: Span[], cut: Span[]): Span[] => {
    const out: Span[] = [];
    for (const f of from) {
      let cursor = f.startMin;
      for (const c of cut) {
        if (c.endMin <= cursor || c.startMin >= f.endMin) continue;
        if (c.startMin > cursor) out.push({ startMin: cursor, endMin: c.startMin });
        cursor = Math.max(cursor, c.endMin);
      }
      if (cursor < f.endMin) out.push({ startMin: cursor, endMin: f.endMin });
    }
    return out;
  };
  return { kept: mergeSpans(kept), added: minus(n, u), removed: minus(u, n) };
}

function hoursWord(min: number): string {
  const h = min / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(2).replace(/0$/, "")} h`;
}

/** "+5.5 h", "−2 h", "+1 h −0.5 h", or "same" - the figure beside each bar. */
export function deltaLabel(delta: { addedMin: number; removedMin: number }): string {
  const parts: string[] = [];
  if (delta.addedMin > 0) parts.push(`+${hoursWord(delta.addedMin)}`);
  if (delta.removedMin > 0) parts.push(`−${hoursWord(delta.removedMin)}`);
  return parts.length > 0 ? parts.join(" ") : "same";
}

/** The weekday (0=Sun) of a "YYYY-MM-DD" date. The date is a calendar date, so no timezone is involved. */
export function weekdayOfDateKey(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "Mon Nov 23" for one date. */
export function dateLabel(dateKey: string): string {
  const [, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return `${WEEKDAY[weekdayOfDateKey(dateKey)]} ${MONTH[m - 1]} ${d}`;
}

/**
 * "Mon Nov 23, Tue 24, Wed 25 and Fri 27" - the month is named on the first
 * date and again only when it changes, so a week reads short and a run across
 * a month end ("Mon Nov 30 and Tue Dec 1") is still unambiguous.
 */
export function datesLabel(dateKeys: readonly string[]): string {
  const sorted = [...new Set(dateKeys)].sort();
  let month = -1;
  const parts = sorted.map((key) => {
    const [, m, d] = key.split("-").map(Number) as [number, number, number];
    const wd = WEEKDAY[weekdayOfDateKey(key)];
    const text = m === month ? `${wd} ${d}` : `${wd} ${MONTH[m - 1]} ${d}`;
    month = m;
    return text;
  });
  return joinWithAnd(parts);
}

function money(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/**
 * The change, read back as one sentence.
 *
 *   hours []        -> "...: Haircut is not offered."
 *   hours [spans]   -> "...: Haircut is open 8:00 AM - 3:30 PM and 4:30 PM - 8:00 PM, at the usual price."
 *   price a number  -> "..., at $60."
 *   staffNames      -> "...: Haircut with Avery is open ..." (an entry for some staff only)
 *
 * Empty when no date is picked yet: there is nothing to read back.
 */
export function dateHoursSentence(input: {
  serviceName: string;
  dates: readonly string[];
  /** [] = not offered those dates. */
  hours: readonly Span[];
  /** A price for those dates; null or absent = the usual price. */
  price?: number | null;
  /** Named only when the change is for some of the staff. */
  staffNames?: readonly string[];
}): string {
  if (input.dates.length === 0) return "";
  const who =
    input.staffNames && input.staffNames.length > 0
      ? `${input.serviceName} with ${joinWithAnd(input.staffNames)}`
      : input.serviceName;
  const head = `${datesLabel(input.dates)}: ${who}`;
  const hours = mergeSpans(input.hours);
  if (hours.length === 0) return `${head} is not offered.`;
  const price = input.price === null || input.price === undefined ? "the usual price" : money(input.price);
  return `${head} is open ${spansLabel(hours)}, at ${price}.`;
}
