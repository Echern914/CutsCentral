import { BACKFILL_MIN_DATE } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { getSquareClientForShop } from "./client.js";
import { ingestSquareBooking } from "./ingest.js";
import { walkSquareBookings } from "./walk.js";
import { SQUARE_BACKFILL_LOOKAHEAD_MS } from "./window.js";
import type { SquareCustomer } from "./types.js";

/**
 * Backfill a shop's Square bookings on first connect (and on repair), so
 * loyalty has the existing visit history immediately AND the calendar has the
 * appointments already on the seller's book. Mirrors acuity/backfill; paging
 * lives in the shared walk. Idempotent (ingest dedupes via the unique Visit
 * constraint), so re-running is always safe.
 *
 * 🔴 THE WINDOW RUNS INTO THE FUTURE, and that is the point. This used to end
 * at `new Date()` — "historical" bookings only — which meant a shop connected
 * Square and its UPCOMING calendar was empty. Everything already on the
 * seller's book was invisible until each one happened to be edited in Square
 * (the only thing that fires a webhook). Worse, since synced Visits block
 * native slots and drive the ~24h reminder sweep, those invisible bookings
 * were double-bookable and their clients got no reminder.
 *
 * Acuity's backfill has always had this: it walks from BACKFILL_MIN_DATE with
 * NO maxDate, i.e. all of history plus everything booked ahead.
 *
 * [VERIFY IN SANDBOX] whether ListBookings returns CANCELLED bookings by
 * default — if not, historical cancels won't backfill, which is low-stakes (a
 * cancelled visit never earned a punch); live cancels still arrive via
 * booking.updated, and the resync sweep reconciles the recent window.
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
  const startAtMax = new Date(Date.now() + SQUARE_BACKFILL_LOOKAHEAD_MS).toISOString();

  // One token read + one fetch per PERSON across the whole backfill, rather
  // than per booking - a first connect walks years of history (see
  // SquareIngestDeps).
  const deps = { client, customers: new Map<string, SquareCustomer | null>() };

  const { handled, failed, pages } = await walkSquareBookings(
    client,
    { shopId, locationId: conn.squareLocationId, startAtMin, startAtMax },
    async (booking) => {
      await ingestSquareBooking(shop, booking.id, booking, deps);
    },
  );

  logger.info({ shopId, count: handled, failed, pages }, "square backfill complete");
  return handled;
}
