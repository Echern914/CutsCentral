/**
 * SPECIAL DAY - the rules for where an opening may sit, shared by the API
 * (which plans and saves a special day under the calendar lock) and the
 * dashboard's live view (which draws the day and lets the barber fill it, tap
 * an opening off, or tap empty time to add one). One copy, so the live view
 * never offers an opening the save would refuse, or refuses one it would take.
 *
 * Unit-agnostic: every number below is in ONE unit the caller picks - the API
 * passes epoch milliseconds, the live view minutes from the shop's midnight.
 *
 * Each opening OWNS [start, end + buffer): the shop's turnover buffer is what
 * the booking guard pads every booking with, so two openings closer than that
 * could not both be booked.
 */

export interface Span {
  start: number;
  end: number;
}

/** Why an opening cannot go where it was asked to. */
export type OpeningConflict = "past" | "booking" | "blocked" | "opening" | "outside_day";

/** Plain words for each conflict, for the live view and the save's refusal. */
export const OPENING_CONFLICT_WORDS: Record<OpeningConflict, string> = {
  past: "that time has already passed",
  booking: "it overlaps a booking",
  blocked: "it overlaps blocked time",
  opening: "it overlaps another opening",
  outside_day: "it runs past the end of the day",
};

/**
 * The opening START times a window holds: every cut + buffer from the start
 * while the whole owned span (cut + buffer) still fits before the end.
 */
export function openingStartMinutes(input: {
  startMin: number;
  endMin: number;
  cutMin: number;
  bufferMin: number;
}): number[] {
  const step = input.cutMin + Math.max(0, input.bufferMin);
  const out: number[] = [];
  if (input.cutMin <= 0) return out;
  for (let m = input.startMin; m + step <= input.endMin; m += step) out.push(m);
  return out;
}

/**
 * What is already on one chair that day, as spans in the caller's unit:
 *   - `bookings`  appointments, requests and live holds on THIS chair - padded
 *                 by the buffer on both sides, exactly as the booking guard does;
 *   - `external`  Acuity/Square bookings (they carry no chair, so they are in
 *                 the way of every chair) - not padded, as the guard does not;
 *   - `blocks`    blocked time of any kind (one-off, weekly break, Acuity
 *                 block). A block scoped to some services still counts: an
 *                 opening may be booked as any of its services.
 */
export interface ChairDay {
  bookings: Span[];
  external: Span[];
  blocks: Span[];
}

/**
 * Why the opening [start, end) cannot sit on this chair - or null when it can.
 * `others` are the chair's OTHER openings (each owning its own end + buffer);
 * `now` refuses a start at or before it; `dayEnd` (optional) refuses an opening
 * whose owned span runs past the end of the day.
 */
export function openingConflict(
  opening: Span,
  day: ChairDay,
  input: { buffer: number; now: number | null; others?: Span[]; dayStart?: number; dayEnd?: number },
): OpeningConflict | null {
  const buffer = Math.max(0, input.buffer);
  const { start, end } = opening;
  if (input.now !== null && start <= input.now) return "past";
  if (
    (input.dayStart !== undefined && start < input.dayStart) ||
    (input.dayEnd !== undefined && end + buffer > input.dayEnd)
  ) {
    return "outside_day";
  }
  if (
    day.bookings.some((b) => b.start < end + buffer && b.end > start - buffer) ||
    day.external.some((v) => v.start < end && v.end > start)
  ) {
    return "booking";
  }
  if (day.blocks.some((b) => b.start < end + buffer && b.end > start)) return "blocked";
  if ((input.others ?? []).some((o) => o.start < end + buffer && o.end + buffer > start)) return "opening";
  return null;
}

/**
 * FILL A DAY: every opening the window holds, minus each one that would sit on
 * something already there (`keep` - e.g. booked openings that stay - counts as
 * "already there" too). Returns what fits and what was left out, and why.
 */
export function fillOpenings(input: {
  startMin: number;
  endMin: number;
  cutMin: number;
  bufferMin: number;
  /** Converts a start minute to the caller's unit (identity for minutes). */
  at?: (min: number) => number;
  /** The caller's unit per minute (1 for minutes, 60_000 for ms). */
  unit?: number;
  day: ChairDay;
  keep?: Span[];
  now: number | null;
}): { openings: Span[]; skipped: { start: number; reason: OpeningConflict }[] } {
  const at = input.at ?? ((m: number) => m);
  const unit = input.unit ?? 1;
  const openings: Span[] = [];
  const skipped: { start: number; reason: OpeningConflict }[] = [];
  for (const min of openingStartMinutes(input)) {
    const start = at(min);
    const span = { start, end: start + input.cutMin * unit };
    const reason = openingConflict(span, input.day, {
      buffer: Math.max(0, input.bufferMin) * unit,
      now: input.now,
      others: [...(input.keep ?? []), ...openings],
    });
    if (reason) skipped.push({ start, reason });
    else openings.push(span);
  }
  return { openings, skipped };
}
