import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { getAcuityClientForShop, type ListParams } from "../acuity/client.js";
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
 * which is wasteful at scale. A small recent window (a couple days back for
 * late edits, out to the shop's booking horizon for new future bookings) keeps
 * each run cheap. Ingest is idempotent via Visit's @@unique([shopId,
 * acuityAppointmentId]), so re-reading the same appointments creates no
 * duplicate clients/visits - re-running is always safe.
 *
 * Idempotent + safe on the single-replica scheduler (see scheduler.ts). Never
 * throws out of a single shop's failure - one shop's expired token or Acuity
 * outage must not stall the sweep for everyone else.
 */

// How far BACK to look, to catch appointments edited/canceled since last sync.
const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000; // 2 days
// How far FORWARD, to catch newly-created future bookings. Comfortably beyond
// any shop's booking horizon (bookingMaxDays is typically <= 60).
const LOOKAHEAD_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const PAGE_SIZE = 200;

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
    let cursor = minDate;
    let lastCursor = "";
    let sameCursorRuns = 0;

    for (;;) {
      const params: ListParams = {
        minDate: cursor,
        maxDate,
        max: PAGE_SIZE,
        direction: "ASC",
        canceled,
      };
      const page = await acuity.listAppointments(params);
      if (page.length === 0) break;

      for (const appt of page) {
        await ingestAppointment(shop, canceled ? "canceled" : "scheduled", appt.id, appt);
        ingested++;
      }

      if (page.length < PAGE_SIZE) break; // final partial page

      // Advance the cursor to the last appointment's date. Guard against a whole
      // page sharing one timestamp (mirrors backfillShop's stuck-cursor guard).
      const nextCursor = ymd(new Date(page[page.length - 1]!.datetime));
      if (nextCursor === lastCursor) {
        if (++sameCursorRuns >= 2) {
          logger.warn({ shopId, cursor }, "acuity resync cursor stuck; stopping page walk");
          break;
        }
      } else {
        sameCursorRuns = 0;
      }
      lastCursor = nextCursor;
      cursor = nextCursor;
    }
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
