/**
 * WHERE A BUSY HOUR STILL HAS ROOM.
 *
 * The day planner lists bookings under the hour they START in, and only an
 * EMPTY hour offered a "+". An hour holding one short 6:20-6:30 booking showed
 * no way in at all, though 6:30-7:00 was free - a barber circled the spot on
 * a screenshot: "Should be able to add an appt right here".
 *
 * This finds the first stretch of at least OPEN_MIN free minutes inside an
 * hour. Per CHAIR: in a shop with two barbers, an hour one of them has full
 * is still open for the other, and the earliest open minute across chairs is
 * the one offered. Rows that belong to no chair (a synced visit, a block from
 * the other calendar) take the time from every chair, which is how the
 * booking guard treats them too.
 *
 * Only a hint of WHERE to start: the appointment form still lists the real
 * open times and offers this one as itself ("Book this time") when it is not
 * among them. Pure: no clock, no I/O.
 */

/** Shorter than this is not a stretch anyone could book into. */
export const OPEN_MIN = 10;

/** One busy span, in minutes from the shop's local midnight. */
export interface BusySpan {
  /** The chair it occupies, or null for every chair. */
  staffId: string | null;
  startMin: number;
  /** Exclusive. May run past the hour (or to 24 * 60 past midnight). */
  endMin: number;
}

/**
 * The first minute of `hour` that starts at least OPEN_MIN free minutes on
 * some chair, or null when the hour has no such room on any chair.
 *
 * `chairs` are the shop's active barbers. With none known, every span counts
 * against one shared chair.
 */
export function firstOpenMinute(busy: BusySpan[], hour: number, chairs: string[]): number | null {
  const lo = hour * 60;
  const hi = lo + 60;
  const candidates = (chairs.length > 0 ? chairs : [null]).map((chair) =>
    firstOpenOnChair(
      busy.filter((b) => chair === null || b.staffId === null || b.staffId === chair),
      lo,
      hi,
    ),
  );
  const open = candidates.filter((m): m is number => m !== null);
  return open.length > 0 ? Math.min(...open) : null;
}

function firstOpenOnChair(spans: BusySpan[], lo: number, hi: number): number | null {
  let t = lo;
  for (const s of [...spans].sort((a, b) => a.startMin - b.startMin)) {
    if (s.endMin <= t) continue; // over before the free run we are measuring
    if (s.startMin >= hi) break;
    if (s.startMin - t >= OPEN_MIN) return t;
    t = Math.max(t, s.endMin);
    if (t >= hi) return null;
  }
  return hi - t >= OPEN_MIN ? t : null;
}

/** "6:30 PM" for minutes from midnight, the way the planner prints times. */
export function clockLabel(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60) % 24;
  const m = minuteOfDay % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
