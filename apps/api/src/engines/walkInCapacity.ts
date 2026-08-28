import { Prisma } from "@chairback/db";
import { QUEUE_ORDER } from "./walkInLifecycle.js";

/**
 * THE walk-in capacity plan: the one projection of "which parts of this chair
 * are spoken for by people already standing in the shop".
 *
 * There is exactly one of these because there were nearly two. The public slot
 * grid (slots.ts) needs it to stop selling a waiting customer's time, and the
 * booking write guard (bookingWrite.ts) needs it to stop a stale grid or a
 * hand-rolled POST doing the same thing a second later. Two copies of this
 * arithmetic would drift the moment either side changed its buffer handling,
 * and the symptom - a slot the grid offers and the write refuses, or worse the
 * reverse - is precisely the bug the plan exists to prevent. So the stacking
 * lives here, both callers import it, and neither owns a second overlap engine.
 *
 * The projection itself:
 *
 *   ASSIGNED and READY entries hold the chair. They STACK sequentially from
 *   `from` in the board's own order (QUEUE_ORDER) - two 30-minute customers
 *   reserve an hour of that chair, not one overlapping half-hour - and each
 *   advances the cursor by its snapshot duration PLUS the turnover buffer, the
 *   same gap the appointment each is about to become will get.
 *
 *   WAITING entries are deliberately NOT projected: nobody has promised them
 *   this chair yet, and reserving for the whole line would black out a barber's
 *   entire afternoon the moment three people walked in.
 *
 * Nothing is stored. Every span is derived from status at read time, so
 * releasing, reassigning or terminalizing an entry frees its time on the very
 * next query - there is no reservation row to forget to delete.
 */

/** A chair span spoken for by one queued customer. Half-open: [start, end). */
export interface WalkInReservedSpan {
  entryId: string;
  /** Epoch ms, inclusive. */
  start: number;
  /** Epoch ms, exclusive. Covers the CUT only - see the buffer note below. */
  end: number;
}

export interface WalkInPlanEntry {
  id: string;
  services: { durationMinAtJoin: number }[];
}

/**
 * Stack queued entries into projected chair spans.
 *
 * 🔴 The returned span covers the CUT ONLY; the turnover buffer is added to the
 * cursor but NOT to the span. That asymmetry is deliberate, and it is what lets
 * both callers stay consistent while padding in the way each already pads:
 *
 *   - the slot grid subtracts buffer-padded BLOCKS from the day, so it re-adds
 *     the buffer to the end of each span (exactly as it does for appointments);
 *   - the write guard pads the CANDIDATE on both sides and compares it against
 *     unpadded rows, so it uses the span as-is (exactly as it does for
 *     appointments).
 *
 * Baking the buffer into the span would double-count it on the write side.
 *
 * `entries` must already be in QUEUE_ORDER - see loadWalkInReservationPlan,
 * which is how both production callers get here.
 */
export function planWalkInReservations(
  entries: readonly WalkInPlanEntry[],
  from: Date,
  bufferMin: number,
): WalkInReservedSpan[] {
  const buffer = Math.max(0, bufferMin) * 60_000;
  const spans: WalkInReservedSpan[] = [];
  let cursor = from.getTime();
  for (const e of entries) {
    const durMin = e.services.reduce((s, x) => s + x.durationMinAtJoin, 0);
    // A zero-duration entry reserves nothing and must not advance the cursor
    // either - it would otherwise push everyone behind it back by a buffer for
    // a customer who is not occupying the chair at all.
    if (durMin <= 0) continue;
    const end = cursor + durMin * 60_000;
    spans.push({ entryId: e.id, start: cursor, end });
    cursor = end + buffer;
  }
  return spans;
}

/**
 * Read this chair's queued entries and project them, in one query.
 *
 * Callers that know the shop does not run Walk-In Mode should skip this
 * entirely rather than relying on it returning empty - that gate is what keeps
 * the cost at zero for every shop that will never have a walk-in.
 */
export async function loadWalkInReservationPlan(
  tx: Prisma.TransactionClient,
  opts: { shopId: string; staffId: string; from: Date; bufferMin: number },
): Promise<WalkInReservedSpan[]> {
  const entries = await tx.walkInEntry.findMany({
    where: {
      shopId: opts.shopId,
      assignedStaffId: opts.staffId,
      status: { in: ["ASSIGNED", "READY"] },
    },
    orderBy: [...QUEUE_ORDER],
    select: { id: true, services: { select: { durationMinAtJoin: true } } },
  });
  return planWalkInReservations(entries, opts.from, opts.bufferMin);
}
