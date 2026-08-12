import { logger } from "../logger.js";
import type { ListParams, SquareClient } from "./client.js";
import type { SquareBooking } from "./types.js";

/**
 * The one Square list-walk, shared by the connect-time backfill and the
 * periodic resync — the same split acuity/walk.ts settled, and for the same
 * reason: two hand-rolled paging loops drift, and the one that drifts is the
 * one nobody is watching.
 *
 * Square paginates with an opaque cursor (unlike Acuity's date cursor), so the
 * loop itself is simple. What it still needs is the guard rails:
 *
 *  - A PAGE CAP, so a server that keeps handing back a cursor can't spin
 *    forever.
 *  - A REPEATED-CURSOR check. A cap alone turns a stuck cursor into 100
 *    pointless round trips per sweep, every sweep, silently. If Square returns
 *    the cursor we just sent, that is not progress — stop and say so.
 *  - Per-booking error isolation: one malformed booking must not abandon the
 *    rest of the page (a shop's whole history behind one bad row).
 */

/** Square's documented max page size for ListBookings. */
export const SQUARE_PAGE_SIZE = 100;

/** Pages one sweep will read before giving up (100 × 100 = 10k bookings). */
const MAX_PAGES = 100;

/** The one method the walk needs — keeps tests to a tiny fake. */
type SquareLister = Pick<SquareClient, "listBookings">;

export interface WalkResult {
  /** Bookings handed to `handle` without throwing. */
  handled: number;
  /** Bookings whose handler threw (logged, then skipped). */
  failed: number;
  pages: number;
}

/**
 * Walk every booking in the window and hand each to `handle` exactly once.
 * Never throws for a single booking; a transport/auth error from listBookings
 * itself DOES propagate (the caller decides whether one shop's failure is
 * fatal to the sweep).
 */
export async function walkSquareBookings(
  square: SquareLister,
  opts: {
    shopId: string;
    locationId?: string | null;
    startAtMin: string;
    startAtMax: string;
  },
  handle: (booking: SquareBooking) => Promise<void>,
): Promise<WalkResult> {
  let cursor: string | null = null;
  let handled = 0;
  let failed = 0;
  let pages = 0;

  for (;;) {
    const params: ListParams = {
      locationId: opts.locationId,
      startAtMin: opts.startAtMin,
      startAtMax: opts.startAtMax,
      limit: SQUARE_PAGE_SIZE,
      cursor,
    };
    const { bookings, cursor: next } = await square.listBookings(params);
    pages++;

    for (const booking of bookings) {
      try {
        await handle(booking);
        handled++;
      } catch (err) {
        failed++;
        logger.error(
          { err, shopId: opts.shopId, bookingId: booking.id },
          "square walk: booking failed; continuing",
        );
      }
    }

    if (!next) break;
    if (next === cursor) {
      // Square handed back the cursor we just sent: the next request would
      // return this same page forever. Bail loudly rather than burn the cap.
      logger.warn(
        { shopId: opts.shopId, pages },
        "square walk: cursor did not advance; stopping",
      );
      break;
    }
    if (pages >= MAX_PAGES) {
      logger.warn(
        { shopId: opts.shopId, pages, handled },
        "square walk: hit the page cap; window may be truncated",
      );
      break;
    }
    cursor = next;
  }

  return { handled, failed, pages };
}
