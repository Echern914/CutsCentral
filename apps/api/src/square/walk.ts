import { logger } from "../logger.js";
import type { ListParams, SquareClient } from "./client.js";
import type { SquareBooking } from "./types.js";
import { SQUARE_MAX_RANGE_MS, SQUARE_SLICE_OVERLAP_MS } from "./window.js";

/**
 * The one Square list-walk, shared by the connect-time backfill and the
 * periodic resync — the same split acuity/walk.ts settled, and for the same
 * reason: two hand-rolled paging loops drift, and the one that drifts is the
 * one nobody is watching.
 *
 * Square paginates with an opaque cursor (unlike Acuity's date cursor), so the
 * loop itself is simple. What it still needs is the guard rails:
 *
 *  - 🔴 SLICES OF AT MOST 30 DAYS. ListBookings refuses a longer start-time
 *    range with a 400 (square/window.ts), so a window of any size - 2015 to a
 *    year ahead, on connect - is walked as consecutive slices, newest first:
 *    the calendar's upcoming bookings land before the years of history do.
 *  - A PAGE CAP per slice, so a server that keeps handing back a cursor can't
 *    spin forever.
 *  - A REPEATED-CURSOR check. A cap alone turns a stuck cursor into 100
 *    pointless round trips per sweep, every sweep, silently. If Square returns
 *    the cursor we just sent, that is not progress — stop and say so.
 *  - Per-booking error isolation: one malformed booking must not abandon the
 *    rest of the page (a shop's whole history behind one bad row).
 *  - Each booking handled ONCE, though the slices overlap by a minute.
 */

/** Square's documented max page size for ListBookings. */
export const SQUARE_PAGE_SIZE = 100;

/** Pages one slice will read before giving up (100 × 100 = 10k bookings). */
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

export interface WindowSlice {
  startAtMin: string;
  startAtMax: string;
}

/**
 * Cut [startAtMin, startAtMax] into ranges Square will accept, newest first.
 * Each is at most SQUARE_MAX_RANGE_MS long; each begins a minute before the
 * one after it ends (SQUARE_SLICE_OVERLAP_MS), and together they cover the
 * whole window. A window that already fits is returned untouched.
 */
export function squareWindowSlices(startAtMin: string, startAtMax: string): WindowSlice[] {
  const min = Date.parse(startAtMin);
  const max = Date.parse(startAtMax);
  // Nothing to cut (or nothing parseable): send it as asked, and let Square's
  // answer be the error rather than inventing one here.
  if (!(max - min > SQUARE_MAX_RANGE_MS)) return [{ startAtMin, startAtMax }];

  const slices: WindowSlice[] = [];
  let end = max;
  for (;;) {
    const start = Math.max(min, end - SQUARE_MAX_RANGE_MS);
    slices.push({
      startAtMin: start === min ? startAtMin : new Date(start).toISOString(),
      startAtMax: end === max ? startAtMax : new Date(end).toISOString(),
    });
    if (start === min) return slices;
    end = start + SQUARE_SLICE_OVERLAP_MS;
  }
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
  let handled = 0;
  let failed = 0;
  let pages = 0;
  // A booking on a slice boundary comes back from both slices.
  const seen = new Set<string>();

  for (const slice of squareWindowSlices(opts.startAtMin, opts.startAtMax)) {
    let cursor: string | null = null;
    let slicePages = 0;
    for (;;) {
      const params: ListParams = {
        locationId: opts.locationId,
        startAtMin: slice.startAtMin,
        startAtMax: slice.startAtMax,
        limit: SQUARE_PAGE_SIZE,
        cursor,
      };
      const { bookings, cursor: next } = await square.listBookings(params);
      pages++;
      slicePages++;

      for (const booking of bookings) {
        if (seen.has(booking.id)) continue;
        seen.add(booking.id);
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
          { shopId: opts.shopId, pages: slicePages, slice },
          "square walk: cursor did not advance; stopping this slice",
        );
        break;
      }
      if (slicePages >= MAX_PAGES) {
        logger.warn(
          { shopId: opts.shopId, pages: slicePages, handled, slice },
          "square walk: hit the page cap; this slice may be truncated",
        );
        break;
      }
      cursor = next;
    }
  }

  return { handled, failed, pages };
}
