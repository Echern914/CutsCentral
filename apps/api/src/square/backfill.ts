import { BACKFILL_MIN_DATE } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { getSquareClientForShop } from "./client.js";
import { ingestSquareBooking } from "./ingest.js";
import { recordSquareSync } from "./syncHealth.js";
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
 * NO maxDate, i.e. all of history plus everything booked ahead. Square will
 * not answer a range that long in one request, so the walk takes it in 30-day
 * slices (square/window.ts) - the step whose absence failed every import.
 *
 * A success stamps `backfilledAt`; until then the resync sweep keeps retrying
 * the whole import (engines/squareResync.ts), so a connect whose import
 * failed - Square down, a token hiccup - heals without anyone pressing Repair.
 *
 * [VERIFY IN SANDBOX] whether ListBookings returns CANCELLED bookings by
 * default — if not, historical cancels won't backfill, which is low-stakes (a
 * cancelled visit never earned a punch); live cancels still arrive via
 * booking.updated, and the resync sweep reconciles the recent window.
 */

/**
 * Shops whose whole-book import is running in THIS process. The connect
 * callback starts one, and the sweep would otherwise start a second on its next
 * tick while the first is still walking years of history: twice the Square
 * calls, and two writers racing on the same Visit rows.
 */
const inFlight = new Set<string>();

/**
 * Import the shop's whole Square book. Returns how many bookings were handled,
 * or null when an import for this shop is already running here (nothing was
 * started).
 */
export async function backfillSquareShop(shopId: string): Promise<number | null> {
  if (inFlight.has(shopId)) {
    logger.info({ shopId }, "square backfill already running for this shop; not starting another");
    return null;
  }
  inFlight.add(shopId);
  try {
    const conn = await prisma.squareConnection.findUnique({ where: { shopId } });
    if (!conn) {
      logger.warn({ shopId }, "square backfill: not connected");
      return 0;
    }
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) return 0;

    // Stamped as of the START: anything Square changed while the walk ran is
    // inside the next sweep's window anyway.
    const startedAt = new Date();
    try {
      const client = await getSquareClientForShop(shopId);
      const startAtMin = new Date(BACKFILL_MIN_DATE).toISOString();
      const startAtMax = new Date(startedAt.getTime() + SQUARE_BACKFILL_LOOKAHEAD_MS).toISOString();

      // One token read + one fetch per PERSON across the whole backfill,
      // rather than per booking - a first connect walks years of history (see
      // SquareIngestDeps).
      const deps = { client, customers: new Map<string, SquareCustomer | null>() };

      const { handled, failed, pages } = await walkSquareBookings(
        client,
        { shopId, locationId: conn.squareLocationId, startAtMin, startAtMax },
        async (booking) => {
          await ingestSquareBooking(shop, booking.id, booking, deps);
        },
      );

      // A booking that failed on its own is logged by the walk and does not
      // hold the import open: retrying years of history every half hour for
      // one malformed row would be the worse failure.
      await recordSquareSync(shopId, { ok: true, at: startedAt, backfilled: true });
      logger.info({ shopId, count: handled, failed, pages }, "square backfill complete");
      return handled;
    } catch (err) {
      await recordSquareSync(shopId, { ok: false, error: err });
      throw err;
    }
  } finally {
    inFlight.delete(shopId);
  }
}
