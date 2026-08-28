import type { Prisma } from "@chairback/db";
import { recordWalkInEvent, WALK_IN_SYSTEM_ACTOR } from "./walkInAudit.js";

/**
 * THE one place a walk-in queue entry becomes COMPLETED.
 *
 * Every path that completes the underlying appointment - the board's
 * Complete action, the chair checkout, the dashboard "mark done", and the
 * end-of-day promotion cron - flows through promoteOneAppointmentInTx, and
 * promoteOneAppointmentInTx calls THIS. One implementation, so "the queue
 * entry becomes terminal exactly once" is a property of the pipeline rather
 * than a per-route promise.
 *
 * Idempotent by CAS: the entry flips only from IN_SERVICE, so a re-run, a
 * repeated tap, or checkout-after-complete is a 0-count no-op with no second
 * audit row. Entries in any other state (already completed, canceled by a
 * manager mid-cut) are deliberately left alone.
 *
 * Kept in its own module (not walkInStart.ts) so appointmentPromotion can
 * import it without a cycle: walkInStart -> appointmentPromotion -> HERE.
 */
export async function completeWalkInEntryForAppointmentInTx(
  tx: Prisma.TransactionClient,
  shopId: string,
  appointmentId: string,
  now: Date,
): Promise<boolean> {
  const flipped = await tx.walkInEntry.updateMany({
    where: { shopId, appointmentId, status: "IN_SERVICE" },
    data: { status: "COMPLETED", completedAt: now },
  });
  if (flipped.count === 0) return false;
  const entry = await tx.walkInEntry.findFirst({
    where: { shopId, appointmentId },
    select: { id: true },
  });
  if (entry) {
    await recordWalkInEvent(tx, {
      shopId,
      entryId: entry.id,
      type: "entry.completed",
      actor: WALK_IN_SYSTEM_ACTOR,
      appointmentId,
      metadata: { fromStatus: "IN_SERVICE", toStatus: "COMPLETED" },
    });
  }
  return true;
}
