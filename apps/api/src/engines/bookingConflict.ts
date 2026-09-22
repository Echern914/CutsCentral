import type { Prisma } from "@chairback/db";
import { occupyingWhere } from "./chairOccupancy.js";
import { DEFAULT_SPAN_MIN, visitSpan } from "./interval.js";

/**
 * WHAT A RECORDED RECEIPT COLLIDED WITH, and how that stops being invisible.
 *
 * A reservation request that collides is refused and never exists, so it needs
 * no record. A RECEIPT is different: the walk-in quick log books a cut that has
 * already happened, with cash already in the till, so refusing it would lose
 * the money rather than free the chair. It is written, and the collision is
 * recorded here instead — durably, because a log line cannot power a manager's
 * follow-up three days later.
 *
 * 🔴 ONE ROW PER (receipt, conflicting KIND + id), enforced by a unique index
 * rather than by remembering to check. That is what makes repeated detection —
 * a client retry, a re-sync, a second sweep — write nothing and alert nobody a
 * second time. `recordConflicts` returns how many rows were genuinely NEW, and
 * the caller alerts only on that.
 */

/**
 * Something that already held the chair when the receipt was written.
 *
 * 🔴 THE PAIR (kind, id) IS THE IDENTITY, and the unique index uses both. These
 * ids come from three independent tables and nothing in the database makes
 * their id spaces disjoint - no shared sequence, no shared domain, no
 * cross-table constraint. Keying on the id alone would mean resting on cuid
 * collisions being improbable, and the failure mode is the wrong way round: the
 * second record - a real, separate double-booking - would be silently swallowed
 * by `skipDuplicates` and never alerted on.
 *
 * ALL THREE KINDS ARE GENUINELY REACHABLE, which is why this is polymorphic
 * rather than premature - but they are not reachable equally, and pretending
 * otherwise would be the same sort of lie:
 *
 * | kind          | when a receipt reports it                                   |
 * |---------------|-------------------------------------------------------------|
 * | `appointment` | on its own - an occupying Appointment on THIS chair           |
 * | `visit`       | on its own - a synced visit (they hold every chair)           |
 * | `block`       | ONLY IN COMPANY - listed when an appointment or visit ALSO    |
 * |               | overlaps, never on its own (see `findConflicts`)              |
 *
 * That asymmetry is deliberate, not an oversight: a block is the barber's own
 * calendar entry, not somebody else's booking, so a walk-in over one alone is
 * him working time he blocked - but once the chair is known to be contested,
 * the manager should see everything that claims it.
 */
export interface DetectedConflict {
  id: string;
  kind: "appointment" | "visit" | "block";
  start: Date;
  end: Date;
}

/**
 * What ELSE held the chair during `[start, end)`, as of `now`.
 *
 * 🔴 THIS IS THE RECEIPT'S WHOLE ANSWER, and it no longer waits for the write
 * guard to throw. The guard answers a different question - may a RESERVATION
 * be made here? - and refuses for reasons that are not occupancy at all: an
 * UNBOOKED targeted slot (an offer of that time, with nobody in it) and the
 * shop's turnover buffer. Treating its refusal as "double-booked" is what put
 * the amber panel on drickcuttinup walk-ins whose time held nothing but his own
 * published, unbooked specials. This asks only what occupancy asks, through the
 * same canonical predicate (`occupyingWhere`) and span rule (`visitSpan`).
 *
 * `now` is the instant occupancy is judged at. For a walk-in recorded live it
 * is the wall clock; for one recorded after the fact it is when the cut
 * happened, so a booking that has since been promoted to COMPLETED still
 * counts as holding the chair then.
 *
 * A synced Visit and an ExternalBlock carry no `staffId` — they hold every
 * chair in the shop — so they are matched shop-wide, exactly as the grid and
 * the guard match them.
 */
export async function findConflicts(
  tx: Prisma.TransactionClient,
  opts: { shopId: string; staffId: string; start: Date; end: Date; now: Date },
): Promise<DetectedConflict[]> {
  const { shopId, staffId, start, end, now } = opts;
  // visitSpan gives a visit with no stored end DEFAULT_SPAN_MIN, so one that
  // started this long before `start` cannot reach it.
  const nullEndFloor = new Date(start.getTime() - DEFAULT_SPAN_MIN * 60_000);
  const completedEndFloor = new Date(Math.max(start.getTime(), now.getTime()));

  const [appointments, visits, blocks] = await Promise.all([
    tx.appointment.findMany({
      where: {
        shopId,
        staffId,
        startsAt: { lt: end },
        endsAt: { gt: start },
        ...occupyingWhere(now),
      },
      select: { id: true, startsAt: true, endsAt: true },
      take: 10,
    }),
    tx.visit.findMany({
      where: {
        shopId,
        appointment: null,
        scheduledAt: { lt: end },
        OR: [
          { status: { in: ["SCHEDULED", "RESCHEDULED"] }, endAt: { gt: start } },
          // NULL-tolerant: a visit with no stored end still holds the chair, and
          // `visitSpan` below supplies the conservative span it holds.
          //
          // 🔴 BOUNDED, because `take` truncates BEFORE that re-check runs.
          // Unbounded, this branch matched a shop's whole imported history:
          // production drickcuttinup carries ~19,900 SCHEDULED visits with no
          // endAt from its Acuity import, `take: 10` returned ten from 2022,
          // the re-check dropped all ten, and a live Acuity booking under the
          // walk-in was never named - no row, no alert, a panel pointing at
          // "something".
          {
            status: { in: ["SCHEDULED", "RESCHEDULED"] },
            endAt: null,
            scheduledAt: { gt: nullEndFloor },
          },
          // A visit that HAPPENED held its span until the span ended - the
          // rule chairOccupancy applies to a COMPLETED appointment. The
          // promotion job flips every fulfilled visit to COMPLETED, so for a
          // walk-in recorded after the fact this is how a past Acuity booking
          // is found at all.
          { status: "COMPLETED", endAt: { gt: completedEndFloor } },
        ],
      },
      select: { id: true, scheduledAt: true, endAt: true },
      take: 10,
    }),
    tx.externalBlock.findMany({
      where: { shopId, startsAt: { lt: end }, endsAt: { gt: start } },
      select: { id: true, startsAt: true, endsAt: true },
      take: 10,
    }),
  ]);

  const out: DetectedConflict[] = appointments.map((a) => ({
    id: a.id,
    kind: "appointment" as const,
    start: a.startsAt,
    end: a.endsAt,
  }));
  for (const v of visits) {
    const span = visitSpan(v);
    // The NULL-end read above is deliberately wide; re-check the real span so a
    // repaired visit that does not actually overlap is not reported.
    if (span.start.getTime() < end.getTime() && span.end.getTime() > start.getTime()) {
      out.push({ id: v.id, kind: "visit", start: span.start, end: span.end });
    }
  }
  // Blocks ONLY IN COMPANY (see the table above). Nobody else is in a block, so
  // one on its own is not a double booking; alongside a real occupant it is
  // part of what the manager needs to see.
  if (out.length === 0) return [];
  for (const b of blocks) {
    out.push({ id: b.id, kind: "block", start: b.startsAt, end: b.endsAt });
  }
  return out;
}

/**
 * Write one row per collision, skipping any that already exist.
 *
 * Returns the number genuinely created. A retry detects the same collisions,
 * writes nothing, and gets 0 back — which is how the caller knows not to alert
 * a second time.
 *
 * 🔴 SAFE FIELDS ONLY. Ids, kinds and the overlap interval. No customer name,
 * phone, email or price goes near this table: a manager resolving a conflict
 * opens the two bookings, and the row exists to point at them, not to copy them.
 */
export async function recordConflicts(
  tx: Prisma.TransactionClient,
  opts: {
    shopId: string;
    staffId: string;
    receiptId: string;
    source: string;
    receiptStart: Date;
    receiptEnd: Date;
    conflicts: DetectedConflict[];
  },
): Promise<number> {
  if (opts.conflicts.length === 0) return 0;
  const { count } = await tx.bookingConflict.createMany({
    data: opts.conflicts.map((c) => ({
      shopId: opts.shopId,
      staffId: opts.staffId,
      receiptId: opts.receiptId,
      conflictingId: c.id,
      conflictingKind: c.kind,
      // The overlap itself, so a reader needs no join to see how bad it is.
      overlapStart: new Date(Math.max(opts.receiptStart.getTime(), c.start.getTime())),
      overlapEnd: new Date(Math.min(opts.receiptEnd.getTime(), c.end.getTime())),
      source: opts.source,
    })),
    skipDuplicates: true,
  });
  return count;
}
