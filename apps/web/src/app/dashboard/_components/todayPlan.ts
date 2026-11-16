import { dayTotals } from "../booking/dayTotals";
import type { TodayRow } from "./TodayAgenda";

/**
 * The arithmetic behind the dashboard's Today page, kept pure so every claim
 * on it is testable: what the day is worth, who is next, what still needs the
 * barber, and where the open time is.
 *
 * Money comes from `dayTotals`, the calendar's own function, so Today and the
 * calendar can never show two different numbers for the same day.
 */

/** A gap shorter than this is changeover, not open time anyone can fill. */
export const GAP_MIN = 30;

/**
 * This many finished bookings before "now" fold into one "Earlier today" row.
 * Seen in the render of a 20-booking day: eight crossed-out rows sat between
 * the barber and what is next. Two or fewer stay in line, as on the board.
 */
export const FOLD_AT = 3;

/** Done or void: dimmed, and never "next" or "left". */
const CLOSED = new Set<TodayRow["status"]>(["completed", "canceled", "no_show"]);

export type ScheduleItem =
  | { kind: "row"; row: TodayRow }
  | {
      kind: "gap";
      start: number;
      end: number;
      minutes: number;
      /** At least GAP_MIN of it is still ahead: worth offering "Fill it". */
      fillable: boolean;
    };

export interface TodayPlan {
  /** Upcoming + completed tickets (requests and cancellations never count). */
  booked: number;
  /** True when bookings exist but none carries a price (a synced calendar). */
  bookedUnknown: boolean;
  /** Bookings still to come or in the chair right now. */
  left: number;
  /** Minutes of fillable open time still ahead today; null = not knowable. */
  openMin: number | null;
  /** The booking in the chair now, else the next one to start. */
  upNext: TodayRow | null;
  /** Requests waiting for a yes or no. */
  requests: TodayRow[];
  /** The day in order, with fillable gaps between bookings. */
  schedule: ScheduleItem[];
  /**
   * How many leading `schedule` items are history (over by the clock) and
   * fold into "Earlier today"; 0 when fewer than FOLD_AT bookings are.
   */
  earlier: number;
  /** The bookings among those folded items - the number the fold shows. */
  earlierBookings: number;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

type Gap = Extract<ScheduleItem, { kind: "gap" }> & { remaining: number };

/**
 * The open stretches between one person's bookings. `holders` must be sorted
 * by start, each with a start and an end. Only the part still ahead is time
 * anyone can fill, and only while that part could still hold a booking:
 * eleven minutes left of a gap is not an invitation.
 */
function gapsBetween(holders: TodayRow[], now: number): Gap[] {
  const out: Gap[] = [];
  let busyUntil: number | null = null;
  for (const r of holders) {
    const start = ms(r.start)!;
    if (busyUntil !== null && start - busyUntil >= GAP_MIN * 60_000) {
      const remaining = Math.round((start - Math.max(busyUntil, now)) / 60_000);
      out.push({
        kind: "gap",
        start: busyUntil,
        end: start,
        minutes: Math.round((start - busyUntil) / 60_000),
        fillable: remaining >= GAP_MIN,
        remaining,
      });
    }
    const end = ms(r.end)!;
    busyUntil = busyUntil === null ? end : Math.max(busyUntil, end);
  }
  return out;
}

export function planToday(rows: TodayRow[], now: number = Date.now()): TodayPlan {
  const sorted = [...rows].sort((a, b) => a.start.localeCompare(b.start));
  const bookings = sorted.filter((r) => r.source !== "block");
  const live = bookings.filter((r) => !CLOSED.has(r.status));

  const totals = dayTotals(sorted, now);
  const priced = bookings.some(
    (r) => (r.status === "upcoming" || r.status === "completed") && r.price !== null,
  );

  // "Left": not closed, and not over by the clock. A cut whose end has passed
  // is done even while the completion sweep has not caught up with it.
  const notOver = (r: TodayRow) => {
    const end = ms(r.end) ?? ms(r.start);
    return end === null || end > now;
  };
  const ahead = live.filter((r) => r.status !== "pending" && notOver(r));

  // In the chair now beats starting next; a request is not a booking yet.
  const upNext = ahead[0] ?? null;

  const schedule: ScheduleItem[] = sorted.map((row) => ({ kind: "row", row }));
  let openMin: number | null = null;
  // Busy spans: every row that holds the chair. A block does, a finished cut
  // did, a request is holding its time; only a cancellation frees it. Without
  // a start and an end, a row cannot bound a gap, so gaps are skipped for the day.
  const holders = sorted.filter((r) => r.status !== "canceled");
  const bounded = holders.length > 0 && holders.every((r) => ms(r.start) !== null && ms(r.end) !== null);
  const people = new Set(holders.map((r) => r.staffId).filter((s): s is string => Boolean(s)));
  const sum = (gaps: Gap[]) => gaps.reduce((t, g) => t + (g.fillable ? g.remaining : 0), 0);

  if (bounded && people.size <= 1) {
    // One person's day (rows without an id - a synced visit - are that same
    // person, which is what a solo shop is): the gaps are drawn in the list.
    const gaps = gapsBetween(holders, now);
    for (const g of gaps) {
      schedule.push({ kind: "gap", start: g.start, end: g.end, minutes: g.minutes, fillable: g.fillable });
    }
    openMin = sum(gaps);
  } else if (bounded) {
    // 🔴 Several people: the owner's list merges everyone, and a gap between
    // Drick's 2:00 and Mike's 3:30 is open on NEITHER, so no gap is drawn.
    // The number still adds up each person's own gaps. A block with no
    // person on it holds everyone; a booking with no person cannot be placed,
    // so the number is not knowable.
    const unplaced = holders.some((r) => !r.staffId && r.source !== "block");
    if (!unplaced) {
      openMin = 0;
      for (const person of people) {
        const theirs = holders.filter((r) => r.staffId === person || (!r.staffId && r.source === "block"));
        openMin += sum(gapsBetween(theirs, now));
      }
    }
  }

  // A gap is listed where it starts, so a cancellation inside it reads after it.
  const at = (i: ScheduleItem) => (i.kind === "gap" ? i.start : (ms(i.row.start) ?? 0));
  schedule.sort((a, b) => at(a) - at(b));

  // The run of items at the top that is over: a gap whose end has passed, a
  // row whose end has passed. It stops at the first thing still ahead, so the
  // fold never reorders the day or hides what is in the chair now.
  let prefix = 0;
  let prefixBookings = 0;
  for (const item of schedule) {
    const over = item.kind === "gap" ? item.end <= now : !notOver(item.row);
    if (!over) break;
    prefix++;
    if (item.kind === "row" && item.row.source !== "block") prefixBookings++;
  }
  const fold = prefixBookings >= FOLD_AT;

  return {
    booked: totals.revenue,
    bookedUnknown: totals.count > 0 && !priced,
    left: ahead.length,
    openMin,
    upNext,
    requests: live.filter((r) => r.status === "pending"),
    schedule,
    earlier: fold ? prefix : 0,
    earlierBookings: fold ? prefixBookings : 0,
  };
}

/** "1h 30m", "45m", "2h". */
export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "Now", "in 18 min", "in 2h 5m" - how soon the next booking is. */
export function startsIn(row: TodayRow, now: number = Date.now()): string {
  const start = ms(row.start);
  if (start === null) return "";
  if (start <= now) return "Now";
  const minutes = Math.ceil((start - now) / 60_000);
  return minutes < 60 ? `in ${minutes} min` : `in ${durationLabel(minutes)}`;
}
