/**
 * Backfill: walk a shop's entire Acuity history (active + canceled passes) and
 * ingest every appointment idempotently. The paging itself lives in walk.ts -
 * shared with the periodic resync so the two can never disagree on how to
 * survive Acuity's server-side `max` cap again.
 */
import { BACKFILL_MIN_DATE } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { getAcuityClientForShop } from "./client.js";
import { walkAcuityAppointments } from "./walk.js";
import { ingestAppointment } from "../ingest.js";

export async function backfillShop(shopId: string): Promise<{ ingested: number }> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new Error(`Shop ${shopId} not found`);
  const acuity = await getAcuityClientForShop(shopId);
  let ingested = 0;

  for (const canceled of [false, true]) {
    ingested += await walkAcuityAppointments(
      acuity,
      { shopId, minDate: `${BACKFILL_MIN_DATE}`, canceled },
      async (appt) => {
        await ingestAppointment(shop, canceled ? "canceled" : "scheduled", appt.id, appt);
      },
    );
  }

  logger.info({ shopId, ingested }, "backfill complete");
  return { ingested };
}
