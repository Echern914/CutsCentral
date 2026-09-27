import { prisma } from "@chairback/db";
import { visitPlatform } from "./visitOrigin.js";

/**
 * TWO RULES ABOUT WHAT A SYNCED VISIT MAY STILL CAUSE - in one place, because
 * the reminder job, the completion job and the rebook push must agree.
 *
 * 1. A VISIT WHOSE STATUS CAN NO LONGER BE CHECKED IS LEFT ALONE.
 *    Once a shop disconnects Acuity (or Square), nothing that happens to that
 *    platform's appointments reaches ChairBack again - a cancellation included.
 *    Reminding the customer about such an appointment, or marking it done and
 *    punching the card when its time passes, would be ChairBack claiming facts
 *    it cannot see. Those visits stay exactly as last synced; they still hold
 *    their time on the calendar until it passes, which is the safe direction.
 *    If the shop reconnects, the next sync settles them and this stops applying.
 *
 * 2. IMPORTED HISTORY IS NEVER ANNOUNCED.
 *    A visit ChairBack first learned about after it had already ended - the
 *    connect-time backfill, a later catch-up - is history, whatever its age.
 *    It keeps every effect on the books (completion, punches, cadence); it
 *    sends the customer nothing: no punch message, no Wallet pass update (the
 *    pass announces "You now have N punches"), no "book your next one". And a
 *    visit completed long after it ended (a reconnect, a stalled job) is not
 *    announced either - a message about a cut from weeks ago is retrospective
 *    however it got here.
 */

/** How long after a visit ends its completion may still be announced. */
export const ANNOUNCE_WITHIN_MS = 24 * 60 * 60 * 1000;

/**
 * May completing this visit tell the customer? Only when ChairBack knew about
 * it before it ended, and it is being completed soon after it ended.
 */
export function mayAnnounceCompletedVisit(
  visit: { createdAt: Date; endAt: Date | null; scheduledAt: Date },
  now: Date,
): boolean {
  const ended = visit.endAt ?? visit.scheduledAt;
  if (visit.createdAt.getTime() > ended.getTime()) return false; // imported as history
  return now.getTime() - ended.getTime() <= ANNOUNCE_WITHIN_MS;
}

/** Was this visit brought in after it had already ended (imported history)? */
export function importedAfterItEnded(visit: {
  createdAt: Date;
  endAt: Date | null;
  scheduledAt: Date;
}): boolean {
  return visit.createdAt.getTime() > (visit.endAt ?? visit.scheduledAt).getTime();
}

/**
 * Of these visits, the ids whose status can no longer be checked: synced from
 * Acuity or Square by a shop that is no longer connected to that platform.
 * ChairBack's own visits (native bookings, manual logs) always can be. One
 * query per platform for the whole batch.
 *
 * Disconnecting in ChairBack deletes the connection row. A seller who revokes
 * ChairBack from inside Square instead leaves the row with `revokedAt` set, and
 * the webhook receiver and the resync both skip it from then on - so a revoked
 * connection is no connection.
 */
export async function visitsWithoutLiveSource(
  visits: Array<{ id: string; shopId: string; acuityAppointmentId: string }>,
): Promise<Set<string>> {
  const synced = visits
    .map((v) => ({ ...v, platform: visitPlatform(v.acuityAppointmentId) }))
    .filter((v) => v.platform !== null);
  if (synced.length === 0) return new Set();
  const shopIds = [...new Set(synced.map((v) => v.shopId))];
  const [acuity, square] = await Promise.all([
    prisma.acuityConnection.findMany({ where: { shopId: { in: shopIds } }, select: { shopId: true } }),
    prisma.squareConnection.findMany({
      where: { shopId: { in: shopIds }, revokedAt: null },
      select: { shopId: true },
    }),
  ]);
  const live = {
    acuity: new Set(acuity.map((c) => c.shopId)),
    square: new Set(square.map((c) => c.shopId)),
  };
  return new Set(synced.filter((v) => !live[v.platform!].has(v.shopId)).map((v) => v.id));
}
