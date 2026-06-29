import type { VisitStatus } from "@chairback/db";
import type { SquareBooking } from "./types.js";

/**
 * Resolve a Visit status from a Square Booking's `status` enum. Unlike Acuity
 * (which carries boolean canceled/noShow flags + an action verb), Square encodes
 * everything in one status string. We map by that enum only.
 *
 * Square BookingStatus values (as of the pinned API version):
 *   PENDING, ACCEPTED            -> live booking            => SCHEDULED
 *   CANCELLED_BY_CUSTOMER,
 *   CANCELLED_BY_SELLER, DECLINED -> cancelled              => CANCELED
 *   NO_SHOW                       -> client didn't show     => NO_SHOW
 * Anything unrecognized is treated as a live booking (SCHEDULED); the
 * status-promotion job later flips past-end SCHEDULED visits to COMPLETED.
 * [VERIFY IN SANDBOX] the exact set of status strings at the pinned version.
 */
export function resolveSquareStatus(booking: SquareBooking): VisitStatus {
  const s = (booking.status ?? "").toUpperCase();
  if (s === "NO_SHOW") return "NO_SHOW";
  if (s === "CANCELLED_BY_CUSTOMER" || s === "CANCELLED_BY_SELLER" || s === "DECLINED") {
    return "CANCELED";
  }
  // PENDING / ACCEPTED / unknown-but-live.
  return "SCHEDULED";
}
