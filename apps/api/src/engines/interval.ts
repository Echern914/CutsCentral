/**
 * WHAT COUNTS AS A TIME SPAN, and when two of them collide. One definition.
 *
 * This module answers only the INTERVAL question. It deliberately does not
 * answer "does this record reserve the chair" — that is a status question and
 * it lives in `chairOccupancy.ts`, because the two are genuinely different and
 * collapsing them is how a completed cut from this morning starts blocking this
 * afternoon. Keep them apart:
 *
 *   interval.ts      — is this span well-formed, and do two spans overlap?
 *   chairOccupancy.ts — does a row of THIS status, at THIS time, hold the chair?
 *
 * 🔴 HALF-OPEN, `[start, end)`. 10:00–10:30 collides with 10:15–10:45 and does
 * NOT collide with 10:30–11:00. That is not a preference: production carries 7
 * live appointment pairs that touch exactly (`a.endsAt = b.startsAt`), and a
 * closed rule would reject all 7 legitimate back-to-back bookings. See
 * docs/booking-integrity-assessment.md.
 *
 * 🔴 A ZERO-LENGTH SPAN IS INVALID, NOT HARMLESS. Under half-open, `[t, t)`
 * contains no instant, so it overlaps nothing — a record with such a span stops
 * blocking its own time while still being drawn on the calendar. That is the
 * `visit.ts` defect exactly: "the calendar says busy, the booking page says
 * free". Zero and negative are refused here so no caller has to remember to.
 */

/** Chair time assumed when a record's real duration cannot be recovered. */
export const DEFAULT_SPAN_MIN = 30;

const MS_PER_MIN = 60_000;

export interface Span {
  start: Date;
  end: Date;
}

/**
 * Is this a span at all? `end` must be strictly after `start`, and both must be
 * real instants — an Invalid Date compares false against everything, which
 * would otherwise sail through every overlap test as "no conflict".
 */
export function isValidSpan(start: Date | null | undefined, end: Date | null | undefined): boolean {
  if (!start || !end) return false;
  const s = start.getTime();
  const e = end.getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
  return e > s;
}

/**
 * Do two spans overlap, half-open? Touching endpoints do not.
 *
 * An invalid span on either side returns false — but callers must not lean on
 * that as a conflict check. Validate on the WRITE side (`isValidSpan`) and
 * repair on the READ side (`visitSpan`); silently treating a malformed row as
 * "conflicts with nothing" is the whole bug.
 */
export function overlaps(a: Span, b: Span): boolean {
  if (!isValidSpan(a.start, a.end) || !isValidSpan(b.start, b.end)) return false;
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/** `[start, start + minutes)`. */
export function spanFrom(start: Date, minutes: number): Span {
  return { start, end: new Date(start.getTime() + Math.max(1, minutes) * MS_PER_MIN) };
}

/**
 * The span a synced Visit occupies — the one place that decides, replacing five
 * different fallbacks that disagreed (`v.endAt ?? v.scheduledAt` in the slot
 * grid, a `continue` on the public page, `?? now` in the promotion job, an
 * instant in the web agenda, 30 minutes in two ingest paths).
 *
 * 🔴 CONSERVATIVE BY CONSTRUCTION. A visit whose end is missing or malformed
 * gets a real, blocking span rather than a zero-length one, because the failure
 * we are avoiding is selling an occupied chair. `derived` says the end was not
 * the record's own, so a caller that can log does — this must never be silent.
 *
 * `Visit` carries `serviceName` but no `serviceId`, so no service duration is
 * reachable from the row; DEFAULT_SPAN_MIN is the same value both ingest paths
 * already store, which keeps a repaired read consistent with a fresh write.
 */
export function visitSpan(visit: {
  scheduledAt: Date;
  endAt: Date | null;
}): Span & { derived: boolean } {
  if (isValidSpan(visit.scheduledAt, visit.endAt)) {
    return { start: visit.scheduledAt, end: visit.endAt!, derived: false };
  }
  return { ...spanFrom(visit.scheduledAt, DEFAULT_SPAN_MIN), derived: true };
}

/**
 * Move a span to a new start, KEEPING ITS REAL DURATION.
 *
 * For an edited synced visit the authoritative duration is the visit's own
 * existing span — it came from Acuity's `endTime` or `duration` at ingest, so
 * preserving the delta preserves the truth rather than substituting a guess.
 * Only when that prior span is itself unusable does DEFAULT_SPAN_MIN apply, and
 * `derived` says so.
 */
export function moveSpan(
  prior: { start: Date; end: Date | null },
  newStart: Date,
): Span & { derived: boolean } {
  if (isValidSpan(prior.start, prior.end)) {
    const durationMs = prior.end!.getTime() - prior.start.getTime();
    return { start: newStart, end: new Date(newStart.getTime() + durationMs), derived: false };
  }
  return { ...spanFrom(newStart, DEFAULT_SPAN_MIN), derived: true };
}
