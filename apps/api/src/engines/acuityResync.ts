import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { getAcuityClientForShop } from "../acuity/client.js";
import { walkAcuityAppointments } from "../acuity/walk.js";
import { syncAcuityBlocks } from "../acuity/blocks.js";
import { ingestAppointment } from "../ingest.js";

/**
 * Periodic Acuity RE-SYNC. The client book the "New appointment" search reads is
 * populated from ingested Acuity APPOINTMENTS (ingest.ts), but ingest only runs
 * at connect-time backfill or on live webhooks. If a webhook was ever missed
 * (e.g. the old dotted-event subscription bug), or a client/appointment was
 * added or edited directly in Acuity, that change never lands until someone runs
 * a manual Repair. This sweep closes that gap: it re-pulls a bounded RECENT
 * window of appointments for every connected shop on a schedule, so the searched
 * names/numbers self-heal without manual intervention.
 *
 * Deliberately NOT a full backfill: backfillShop walks from 2015 every run,
 * which is wasteful at scale. The window is a week back (a missed webhook on a
 * PAST appointment - a late cancel, an edit - is unrecoverable once it ages out
 * of the lookback, so give it real slack) and a year forward (Acuity itself has
 * no booking horizon: standing clients book months out, and anything past the
 * lookahead only ever landed via connect-time backfill - it would stay
 * invisible until it drifted inside the window). A year of one shop's
 * appointments is a handful of pages per pass - the cost is a few HTTP calls
 * every 30 minutes, the payoff is that the calendar simply has everything.
 * Ingest is idempotent via Visit's @@unique([shopId, acuityAppointmentId]), so
 * re-reading the same appointments creates no duplicate clients/visits -
 * re-running is always safe.
 *
 * Idempotent + safe on the single-replica scheduler (see scheduler.ts). Never
 * throws out of a single shop's failure - one shop's expired token or Acuity
 * outage must not stall the sweep for everyone else.
 */

// How far BACK to look, to catch appointments edited/canceled since last sync.
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// How far FORWARD, to catch newly-created future bookings.
const LOOKAHEAD_MS = 365 * 24 * 60 * 60 * 1000; // 365 days

/** Acuity minDate/maxDate accept a plain YYYY-MM-DD (see BACKFILL_MIN_DATE). */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Re-sync one shop's recent Acuity window. Returns how many were ingested. */
async function resyncShop(shopId: string, now: Date): Promise<number> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) return 0;
  const acuity = await getAcuityClientForShop(shopId);
  const minDate = ymd(new Date(now.getTime() - LOOKBACK_MS));
  const maxDate = ymd(new Date(now.getTime() + LOOKAHEAD_MS));
  let ingested = 0;

  // Both active and canceled passes (a cancel edited in Acuity must reconcile).
  for (const canceled of [false, true]) {
    ingested += await walkAcuityAppointments(
      acuity,
      { shopId, minDate, maxDate, canceled },
      async (appt) => {
        await ingestAppointment(shop, canceled ? "canceled" : "scheduled", appt.id, appt);
      },
    );
  }

  // Blocked-off time, reconciled over the same window: time the barber blocked
  // in Acuity must not be offered by the native picker, must show on the
  // calendar, and must not count as open capacity in Chair time. Never fatal -
  // a shop whose blocks fail to read still gets its appointments.
  try {
    const blocks = await acuity.listBlocks({ minDate, maxDate });
    const res = await syncAcuityBlocks(
      shopId,
      blocks,
      new Date(`${minDate}T00:00:00.000Z`),
      new Date(new Date(`${maxDate}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000),
    );
    if (res.upserted > 0 || res.removed > 0) {
      logger.info({ shopId, ...res }, "acuity blocked time synced");
    }
  } catch (err) {
    logger.error({ err, shopId }, "acuity block sync failed (appointments still synced)");
  }

  return ingested;
}

export async function runAcuityResync(now = new Date()): Promise<number> {
  const conns = await prisma.acuityConnection.findMany({ select: { shopId: true } });
  if (conns.length === 0) return 0; // no Acuity shops - hard no-op
  let ingested = 0;
  let failed = 0;
  for (const conn of conns) {
    try {
      ingested += await resyncShop(conn.shopId, now);
    } catch (err) {
      failed++;
      logger.error({ err, shopId: conn.shopId }, "acuity resync failed for shop");
    }
  }
  logger.info(
    { shops: conns.length, ingested, failed },
    "acuity resync sweep complete",
  );
  return ingested;
}
