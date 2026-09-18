import type { Prisma } from "@chairback/db";
import { occupyingWhere } from "./chairOccupancy.js";
import { visitSpan } from "./interval.js";

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
 * | kind          | how a walk-in reaches it                                    |
 * |---------------|-------------------------------------------------------------|
 * | `appointment` | on its own - the guard throws SlotTakenError on an overlapping
 * |               | Appointment (bookingWrite.ts, appointment probe) and this runs |
 * | `visit`       | on its own - same, via the synced-Visit probe                 |
 * | `block`       | ONLY IN COMPANY. The walk-in passes `externalBlocks:"ignore"`,
 * |               | so an ExternalBlock alone never throws and this never runs. A
 * |               | block is recorded when an appointment or visit ALSO overlaps:
 * |               | that throws, and the sweep below then names everything holding
 * |               | the chair, blocks included.                                  |
 *
 * That asymmetry is deliberate, not an oversight: a person is physically in the
 * chair, so an Acuity entry must not eject them - but once the chair is known
 * to be contested, the manager should see everything that claims it.
 */
export interface DetectedConflict {
  id: string;
  kind: "appointment" | "visit" | "block";
  start: Date;
  end: Date;
}

/**
 * Everything overlapping `[start, end)` that counts as holding the chair.
 *
 * Deliberately asks the SAME questions the write guard asks, through the same
 * canonical predicate (`occupyingWhere`) and the same span rule (`visitSpan`),
 * so what gets reported can never drift from what got refused. It runs only
 * after the guard has already thrown, so the extra reads cost nothing on the
 * ordinary path.
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
        status: { in: ["SCHEDULED", "RESCHEDULED"] },
        appointment: null,
        scheduledAt: { lt: end },
        // NULL-tolerant: a visit with no stored end still holds the chair, and
        // `visitSpan` below supplies the conservative span it holds.
        OR: [{ endAt: { gt: start } }, { endAt: null }],
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

  const out: DetectedConflict[] = [
    ...appointments.map((a) => ({
      id: a.id,
      kind: "appointment" as const,
      start: a.startsAt,
      end: a.endsAt,
    })),
    ...blocks.map((b) => ({
      id: b.id,
      kind: "block" as const,
      start: b.startsAt,
      end: b.endsAt,
    })),
  ];
  for (const v of visits) {
    const span = visitSpan(v);
    // The NULL-end read above is deliberately wide; re-check the real span so a
    // repaired visit that does not actually overlap is not reported.
    if (span.start.getTime() < end.getTime() && span.end.getTime() > start.getTime()) {
      out.push({ id: v.id, kind: "visit", start: span.start, end: span.end });
    }
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
