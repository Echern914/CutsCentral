/**
 * THE WEEK GRID'S GEOMETRY. Pure, so the arithmetic the eye relies on - where
 * a booking sits, and how two bookings that overlap share a column - is
 * tested without a browser.
 *
 * Every minute here is a SHOP wall-clock minute from that day's midnight
 * (0-1440), the same minute the day planner reads, so a booking sits at the
 * hour the shop's clock says on every device.
 */

/** One hour of the week grid, in px. Tall enough for a name and a time line on a 30-minute cut. */
export const HOUR_PX = 72;
/** The hours the week shows when nothing falls outside them. */
export const WEEK_DEFAULT_START_HOUR = 8;
export const WEEK_DEFAULT_END_HOUR = 20;
/** The shortest a booking draws: one line of name. A 10-minute slot still gets a target. */
export const MIN_EVENT_PX = 22;

export interface Span {
  startMin: number;
  endMin: number;
}

/**
 * A booking's span on its day. No end (a synced row that never said) or an end
 * that is not after the start reads as 30 minutes. An end on the next day (a
 * late cut, or a block already clipped to this day by spreadAcrossDays, which
 * ends at the next midnight) runs to the bottom of the day.
 */
export function spanOf(
  row: { start: string; end: string | null },
  minuteOf: (iso: string) => number,
): Span {
  const startMin = minuteOf(row.start);
  const endsAfter = row.end !== null && Date.parse(row.end) > Date.parse(row.start);
  if (!endsAfter) return { startMin, endMin: Math.min(startMin + 30, 24 * 60) };
  const endMin = minuteOf(row.end!);
  return { startMin, endMin: endMin <= startMin ? 24 * 60 : endMin };
}

/**
 * The hours the grid draws: the default window, widened to the whole hour
 * around anything outside it, so a 7 AM cut or a 10 PM block is never cut off
 * the bottom of the week.
 */
export function weekHourWindow(spans: Span[]): { startHour: number; endHour: number } {
  let startHour = WEEK_DEFAULT_START_HOUR;
  let endHour = WEEK_DEFAULT_END_HOUR;
  for (const s of spans) {
    startHour = Math.min(startHour, Math.floor(s.startMin / 60));
    endHour = Math.max(endHour, Math.ceil(s.endMin / 60));
  }
  return { startHour: Math.max(0, startHour), endHour: Math.min(24, endHour) };
}

/** px from the top of the grid for a wall-clock minute. */
export function topPx(minute: number, startHour: number): number {
  return ((minute - startHour * 60) / 60) * HOUR_PX;
}

export interface Placed<T> {
  item: T;
  top: number;
  height: number;
  /** Which of `lanes` side-by-side columns it takes, from 0. */
  lane: number;
  lanes: number;
}

/**
 * Lay out one day: each booking at its time, and bookings that overlap side by
 * side rather than on top of each other (a double-booking, or two providers'
 * clients at 10:00, must both be readable and both clickable).
 *
 * Overlap is judged on what is DRAWN, not the minutes: a 10-minute booking is
 * drawn MIN_EVENT_PX tall, and one starting 10 minutes later would otherwise
 * be painted over it. Lanes are counted per cluster of touching bookings, so
 * one double-booking at 10:00 does not halve every booking of the day.
 */
export function placeDay<T>(
  items: readonly T[],
  spanFor: (item: T) => Span,
  startHour: number,
): Placed<T>[] {
  const minDrawnMin = Math.ceil((MIN_EVENT_PX / HOUR_PX) * 60);
  const sorted = items
    .map((item) => {
      const span = spanFor(item);
      return { item, span, drawnEnd: Math.max(span.endMin, span.startMin + minDrawnMin) };
    })
    .sort((a, b) => a.span.startMin - b.span.startMin || b.span.endMin - a.span.endMin);

  const out: Placed<T>[] = [];
  let cluster: Placed<T>[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;
  const closeCluster = () => {
    for (const p of cluster) p.lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
    clusterEnd = -Infinity;
  };

  for (const { item, span, drawnEnd } of sorted) {
    if (span.startMin >= clusterEnd) closeCluster();
    let lane = laneEnds.findIndex((end) => end <= span.startMin);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(drawnEnd);
    } else {
      laneEnds[lane] = drawnEnd;
    }
    const placed: Placed<T> = {
      item,
      top: topPx(span.startMin, startHour),
      height: Math.max(MIN_EVENT_PX, ((span.endMin - span.startMin) / 60) * HOUR_PX),
      lane,
      lanes: 1,
    };
    cluster.push(placed);
    out.push(placed);
    clusterEnd = Math.max(clusterEnd, drawnEnd);
  }
  closeCluster();
  return out;
}

/**
 * "Nov 15 – 21", or "Nov 29 – Dec 5" across a month edge. From day keys, at
 * local noon like every key formatter in the calendar, so no zone shifts the day.
 */
export function weekRangeLabel(firstKey: string, lastKey: string): string {
  const at = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y!, m! - 1, d!, 12);
  };
  const a = at(firstKey);
  const b = at(lastKey);
  const month = new Intl.DateTimeFormat("en-US", { month: "short" });
  const sameMonth = a.getMonth() === b.getMonth();
  return `${month.format(a)} ${a.getDate()} – ${sameMonth ? "" : `${month.format(b)} `}${b.getDate()}`;
}
