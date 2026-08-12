import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { getSquareClientForShop } from "../square/client.js";
import { ingestSquareBooking } from "../square/ingest.js";
import { walkSquareBookings } from "../square/walk.js";
import type { SquareCustomer } from "../square/types.js";
import {
  SQUARE_RESYNC_LOOKAHEAD_MS,
  SQUARE_RESYNC_LOOKBACK_MS,
} from "../square/window.js";

/**
 * Periodic Square RE-SYNC — the Acuity sweep's twin (engines/acuityResync.ts),
 * for the same reason and with the same window.
 *
 * Square bookings only reached us two ways: the connect-time backfill, and
 * booking.created / booking.updated webhooks. Webhooks are a single point of
 * failure — an endpoint blip, a deploy mid-delivery, a signature key rotated
 * in the Console, or simply an event Square never sent — and NOTHING re-read
 * the book afterwards. Acuity has been self-healing on a 30-minute sweep since
 * #99; Square has had no equivalent, so a dropped event stayed dropped until
 * someone thought to hit Repair.
 *
 * That gap is not cosmetic, because a synced Visit is load-bearing:
 *   - it BLOCKS native slots (#147), so a booking we missed is a slot we will
 *     happily double-book;
 *   - it drives the ~24h synced-visit reminder sweep (#212), so a booking we
 *     missed is a client who never gets reminded;
 *   - it feeds the client book, Chair time and the calendar.
 *
 * Deliberately NOT a full backfill: that walks from 2015 every pass. The
 * window is bounded (see square/window.ts) and re-reading is free of
 * consequence — ingest is idempotent on Visit's
 * @@unique([shopId, acuityAppointmentId]) under a "square:{bookingId}"
 * namespace, so a re-read updates in place rather than duplicating.
 *
 * Idempotent + safe on the single-replica scheduler (see scheduler.ts). Never
 * throws out of one shop's failure: an expired token or a Square outage at one
 * merchant must not stall the sweep for everyone else.
 */

export interface SquareResyncResult {
  shops: number;
  ingested: number;
  failedShops: number;
}

/** Re-sync one shop's recent Square window. Returns how many were ingested. */
async function resyncShop(
  shopId: string,
  locationId: string | null,
  now: Date,
): Promise<number> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) return 0;

  const client = await getSquareClientForShop(shopId);
  const startAtMin = new Date(now.getTime() - SQUARE_RESYNC_LOOKBACK_MS).toISOString();
  const startAtMax = new Date(now.getTime() + SQUARE_RESYNC_LOOKAHEAD_MS).toISOString();
  // Shared for the whole shop: one token read + decrypt, and one fetch per
  // PERSON rather than per booking (see SquareIngestDeps). Scoped to this
  // sweep, so a customer edited in Square is picked up on the next one.
  const deps = { client, customers: new Map<string, SquareCustomer | null>() };

  const { handled, failed } = await walkSquareBookings(
    client,
    { shopId, locationId, startAtMin, startAtMax },
    async (booking) => {
      // Pass the booking we already have rather than re-fetching it by id -
      // one HTTP call per booking would make a 500-booking shop a 500-request
      // sweep every 30 minutes.
      await ingestSquareBooking(shop, booking.id, booking, deps);
    },
  );
  if (failed > 0) {
    logger.warn({ shopId, failed }, "square resync: some bookings failed to ingest");
  }
  return handled;
}

export async function runSquareResync(now = new Date()): Promise<SquareResyncResult> {
  const conns = await prisma.squareConnection.findMany({
    // Skip sellers who revoked us (oauth.authorization.revoked): the row is
    // kept so their visits/clients survive, but every API call would 401.
    // Sweeping them would burn two requests and log an error per shop, every
    // 30 minutes, forever - noise that hides a real failure.
    where: { revokedAt: null },
    select: { shopId: true, squareLocationId: true },
  });
  // Hard no-op when no Square shops are connected - the common case today, and
  // it must cost nothing.
  if (conns.length === 0) return { shops: 0, ingested: 0, failedShops: 0 };

  let ingested = 0;
  let failedShops = 0;
  for (const conn of conns) {
    try {
      ingested += await resyncShop(conn.shopId, conn.squareLocationId, now);
    } catch (err) {
      failedShops++;
      logger.error({ err, shopId: conn.shopId }, "square resync failed for shop");
    }
  }
  logger.info(
    { shops: conns.length, ingested, failed: failedShops },
    "square resync sweep complete",
  );
  return { shops: conns.length, ingested, failedShops };
}
