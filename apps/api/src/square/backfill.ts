import { BACKFILL_MIN_DATE } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { getSquareClientForShop } from "./client.js";
import { ingestSquareBooking } from "./ingest.js";

/**
 * Backfill a shop's historical Square bookings on first connect (and on repair),
 * so loyalty has the existing visit history immediately. Mirrors acuity/backfill
 * but uses Square's cursor pagination. Idempotent (ingest dedupes via the unique
 * Visit constraint), so re-running is safe.
 *
 * [VERIFY IN SANDBOX] whether ListBookings returns CANCELLED bookings by default
 * — if not, historical cancels won't backfill, which is low-stakes (a cancelled
 * visit never earned a punch); live cancels still arrive via booking.updated.
 */
export async function backfillSquareShop(shopId: string): Promise<number> {
  const conn = await prisma.squareConnection.findUnique({ where: { shopId } });
  if (!conn) {
    logger.warn({ shopId }, "square backfill: not connected");
    return 0;
  }
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) return 0;

  const client = await getSquareClientForShop(shopId);
  const startAtMin = new Date(BACKFILL_MIN_DATE).toISOString();
  const startAtMax = new Date().toISOString();

  let cursor: string | null = null;
  let count = 0;
  let pages = 0;
  do {
    const { bookings, cursor: next } = await client.listBookings({
      locationId: conn.squareLocationId,
      startAtMin,
      startAtMax,
      limit: 100,
      cursor,
    });
    for (const booking of bookings) {
      try {
        await ingestSquareBooking(shop, booking.id, booking);
        count++;
      } catch (err) {
        logger.error({ err, shopId, bookingId: booking.id }, "square backfill ingest failed");
      }
    }
    cursor = next;
    pages++;
    // Safety cap so a runaway cursor can't loop forever.
  } while (cursor && pages < 100);

  logger.info({ shopId, count, pages }, "square backfill complete");
  return count;
}
