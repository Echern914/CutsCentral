/**
 * Backfill: walk a shop's Acuity history via a date cursor and ingest every
 * appointment idempotently. Implemented in Phase 5.
 */
import { BACKFILL_MIN_DATE } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { getAcuityClientForShop, type ListParams } from "./client.js";
import { ingestAppointment } from "../ingest.js";

const PAGE_SIZE = 200;

/**
 * Walk ASC from BACKFILL_MIN_DATE, ingest each appointment, advance the cursor
 * to the last appointment's datetime, stop on a short page. Runs once for active
 * appointments and once for canceled. Idempotent via Visit's unique constraint,
 * so re-running is always safe.
 */
export async function backfillShop(shopId: string): Promise<{ ingested: number }> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new Error(`Shop ${shopId} not found`);
  const acuity = await getAcuityClientForShop(shopId);
  let ingested = 0;

  for (const canceled of [false, true]) {
    let cursor = `${BACKFILL_MIN_DATE}`;
    // Guard against a stuck cursor (same timestamp filling a whole page).
    let lastCursor = "";
    let sameCursorRuns = 0;

    for (;;) {
      const params: ListParams = {
        minDate: cursor,
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

      const last = page[page.length - 1]!;
      const nextCursor = last.datetime;

      if (page.length < PAGE_SIZE) break; // final partial page

      if (nextCursor === lastCursor) {
        // Whole page shares the cursor timestamp — bail to avoid an infinite
        // loop. At one small shop this effectively never happens; the unique
        // constraint already prevents duplicates if we did re-read.
        if (++sameCursorRuns >= 2) {
          logger.warn({ shopId, cursor }, "backfill cursor stuck; stopping page walk");
          break;
        }
      } else {
        sameCursorRuns = 0;
      }
      lastCursor = nextCursor;
      cursor = nextCursor;
    }
  }

  logger.info({ shopId, ingested }, "backfill complete");
  return { ingested };
}
