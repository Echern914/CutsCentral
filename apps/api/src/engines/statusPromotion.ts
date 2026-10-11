import { prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { earnPunchForVisitInTx, type EarnResult } from "../services/punch.js";
import { notifyPunchEarned } from "../services/loyaltyNotify.js";
import { recomputeCadence } from "./cadence.js";
import { mayAnnounceCompletedVisit, visitsWithoutLiveSource } from "./syncedVisitTrust.js";

/**
 * Acuity never fires a "completed" event. A visit becomes COMPLETED once its end
 * time has passed and it wasn't canceled. This job promotes such visits, earns
 * punches per the shop's earn rules (idempotent; a visit that ended before the
 * shop's rewards started completes but earns nothing - services/punch.ts), and
 * recomputes the client's cadence.
 *
 * Runs across all shops; idempotent (promoted rows no longer match the filter).
 *
 * 🔴 BOUNDED, NEWEST FIRST. One run completes at most `limit` visits. A shop
 * whose history arrives at once (19,637 visits in one import on a live shop)
 * would otherwise be one run doing ~100k writes under a 5-minute lease. The
 * NEWEST go first, so a visit that just ended is completed - and announced,
 * which only happens within a day of it ending (syncedVisitTrust.ts) - while a
 * backlog of old history drains quietly over the next runs. Visits that can't
 * be verified are set aside BEFORE the batch is taken, so a disconnected shop's
 * pile can never occupy the whole batch and stall everyone else.
 *
 * @param opts.shopId  Test-only scope, so parallel test files never promote
 *                     each other's visits.
 */
export const PROMOTE_BATCH = 1000;

export async function promoteCompletedVisits(
  now = new Date(),
  opts: { limit?: number; shopId?: string } = {},
): Promise<number> {
  const limit = opts.limit ?? PROMOTE_BATCH;
  const dueAll = await prisma.visit.findMany({
    where: {
      ...(opts.shopId ? { shopId: opts.shopId } : {}),
      status: { in: ["SCHEDULED", "RESCHEDULED"] },
      endAt: { lt: now },
      canceledAt: null,
      noShow: false, // a no-show never completes or earns a punch
    },
    orderBy: [{ endAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      shopId: true,
      clientId: true,
      serviceName: true,
      endAt: true,
      scheduledAt: true,
      createdAt: true,
      acuityAppointmentId: true,
    },
  });
  if (dueAll.length === 0) return 0;
  // A synced visit whose platform the shop has disconnected cannot be checked
  // any more - it may have been cancelled there. Leave it as last synced
  // rather than completing and punching it (syncedVisitTrust.ts, rule 1).
  const unverifiable = await visitsWithoutLiveSource(dueAll);
  const due = dueAll.filter((v) => !unverifiable.has(v.id)).slice(0, limit);

  // One shop lookup for the whole batch - the earn rate is per shop.
  const shops = await prisma.shop.findMany({
    where: { id: { in: [...new Set(due.map((v) => v.shopId))] } },
    select: { id: true, punchesPerVisit: true },
  });
  const shopById = new Map(shops.map((s) => [s.id, s]));

  let promoted = 0;
  let failed = 0;
  for (const v of due) {
    // The shop must exist - visits cascade-delete with their shop.
    const shop = shopById.get(v.shopId);
    if (!shop) continue;

    // 🔴 ONE TRANSACTION PER VISIT: COMPLETE IT AND EARN, OR NEITHER.
    //
    // This used to set COMPLETED in one write and earn in a separate
    // transaction, unconditionally and with nothing catching a failure:
    //  - a resync that cancelled (or no-showed) the visit after the list
    //    above was read was overwritten back to COMPLETED, and earned;
    //  - an earn that failed left the visit COMPLETED with no punch - never
    //    retried, since completed visits drop out of this query - and threw
    //    out of the loop, so every visit after it waited for the next run.
    // Now the status moves only while the visit is STILL due (a compare-and-
    // set on what made it due), in the same commit as its punch; a failure
    // rolls both back, so the next run simply tries it again, and the loop
    // moves on. The client row is locked first, as ingest's own write takes
    // it before the visit's, so a resync of this visit waits for this commit
    // (and then claws back what it must) rather than slipping past it.
    let outcome: { completed: false } | { completed: true; earn: EarnResult };
    try {
      outcome = await runWithShop(v.shopId, async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${v.clientId} FOR UPDATE`;
        const moved = await tx.visit.updateMany({
          where: {
            id: v.id,
            shopId: v.shopId,
            status: { in: ["SCHEDULED", "RESCHEDULED"] },
            endAt: { lt: now },
            canceledAt: null,
            noShow: false,
          },
          data: { status: "COMPLETED", completedAt: now },
        });
        if (moved.count === 0) return { completed: false as const };
        // As it stands now - a resync may have changed the service since.
        const current = await tx.visit.findUniqueOrThrow({
          where: { id: v.id },
          select: { serviceName: true, endAt: true },
        });
        // The visit "happened" when it ended, which is what promo windows
        // check against.
        const earn = await earnPunchForVisitInTx(
          tx,
          shop,
          v.clientId,
          v.id,
          current.serviceName,
          current.endAt ?? now,
        );
        return { completed: true as const, earn };
      });
    } catch (err) {
      failed++;
      logger.error({ err, visitId: v.id, shopId: v.shopId }, "visit completion failed; retried next run");
      continue;
    }
    // Cancelled, no-showed or moved since the read above: left as it is.
    if (!outcome.completed) continue;
    promoted++;

    try {
      await recomputeCadence(v.shopId, v.clientId);
      // Tell the client they earned punches (gated by the shop toggle + consent +
      // quiet hours inside notify). Only on a genuine first earn - a re-run of this
      // job returns null and stays silent. Awaited but never throws.
      // 🔴 NEVER FOR IMPORTED HISTORY (syncedVisitTrust.ts, rule 2): a visit
      // ChairBack learned about after it ended keeps its punch but announces
      // nothing - one message per old cut was the connect-time flood.
      const earn = outcome.earn;
      if (earn && mayAnnounceCompletedVisit(v, now)) {
        await notifyPunchEarned({
          shopId: v.shopId,
          clientId: v.clientId,
          earned: earn.earned,
          balance: earn.balance,
          cardTypeId: earn.cardTypeId,
          cardName: earn.cardName,
          now,
        });
      }
    } catch (err) {
      // The visit and its punch are committed; only the follow-up failed.
      // Cadence is recomputed again on this client's next visit change.
      logger.error({ err, visitId: v.id, shopId: v.shopId }, "visit completed; cadence/notify failed");
    }
  }

  logger.info(
    {
      promoted,
      failed,
      leftUnverified: unverifiable.size,
      // Still due after this batch: a backlog drains over the next runs.
      backlog: dueAll.length - unverifiable.size - promoted,
    },
    "promoted completed visits",
  );
  return promoted;
}
