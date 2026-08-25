/**
 * THE DECISIONS behind mirroring ChairBack occupancy out to Square, kept pure
 * so every branch is provable without a database or a network.
 *
 * The Acuity twin of this file answers three questions. Square needs two more,
 * and both come from the same root cause: Square has no blocked-time concept,
 * so the mirror has to be a REAL Booking on the seller's calendar.
 *
 *   1. Is this shop eligible?                    -> isSquareMirrorEligible
 *   2. Does this appointment occupy the chair?   -> (shared with Acuity)
 *   3. Did that failed call maybe still write?   -> classifySquareFailure
 *   4. Did Square actually HOLD the time?        -> interpretBookingStatus
 *   5. Is this webhook our own booking coming home? -> isSelfEcho
 *
 * Question 4 is the one with teeth. Square's Bookings API can answer a create
 * with status PENDING, which means the seller has to accept it before the time
 * is held - so the booking exists and the chair is still sellable. Treating
 * that as success would put a "protected" badge over an unprotected chair,
 * which is worse than not mirroring at all. The status is therefore read from
 * Square's actual response on every write, never assumed.
 */

import type { SquareOutboundMode } from "@chairback/db";

//  1. Eligibility

export interface SquareMirrorShopSlice {
  bookingMode: string;
  squareOutboundMode: SquareOutboundMode;
  /** Whether a live (non-revoked) SquareConnection exists for the shop. */
  squareConnected: boolean;
}

export type SquareMirrorAction = "create" | "release";

/**
 * May we act on this shop, for this kind of action?
 *
 * CREATE is gated hard: native booking, a live connection, mode ENFORCE.
 * OBSERVE evaluates and reports but never writes.
 *
 * RELEASE is deliberately NOT gated on the mode, for the same reason as
 * Acuity's: a booking ChairBack created belongs to ChairBack, and switching a
 * shop OFF must never strand it on the seller's calendar. "We stopped
 * mirroring" cannot be allowed to mean "your Tuesday is booked solid forever
 * with a customer who does not exist".
 */
export function isSquareMirrorEligible(
  shop: SquareMirrorShopSlice,
  action: SquareMirrorAction,
): boolean {
  if (!shop.squareConnected) return false;
  if (action === "release") return true;
  return shop.bookingMode === "native" && shop.squareOutboundMode === "ENFORCE";
}

/** OBSERVE: compute and log the intended call, perform no Square write. */
export function shouldSquareObserve(shop: SquareMirrorShopSlice): boolean {
  return (
    shop.squareConnected &&
    shop.bookingMode === "native" &&
    shop.squareOutboundMode === "OBSERVE"
  );
}

//  2. Failure classification

export type SquareFailureKind = "definitive" | "ambiguous";

/**
 * Anything that is not a proven rejection is ambiguous.
 *
 * Identical doctrine to the Acuity engine, and for the identical reason: a
 * timeout, a reset, a 429 or a 502 can all follow a request Square actually
 * processed. Compensating on those would cancel a real customer's appointment
 * because we lost a response, AND leave a live booking on the seller's
 * calendar. Ambiguity goes to UNKNOWN; only the reconciler resolves it.
 *
 * Square is kinder here than Acuity was: replaying the same idempotency key
 * returns the original booking rather than making a second one, so recovery is
 * a retry rather than a search. That is why the key is minted once at intent
 * time and never regenerated.
 */
const DEFINITIVE_STATUSES = new Set([400, 401, 403, 404, 422]);

export function classifySquareFailure(
  status: number | null,
  code?: string | null,
): SquareFailureKind {
  if (status === null) return "ambiguous"; // transport-level: no answer at all
  if (status === 408 || status === 429) return "ambiguous";
  if (status >= 500) return "ambiguous";
  // 409 is NOT definitive for Square. Its CONFLICT surfaces both "you sent a
  // stale version" (safe) and idempotency-key contention on a request that may
  // still be in flight (not safe), and the two are indistinguishable from the
  // status alone. Only the version-mismatch code is treated as proven.
  if (status === 409) {
    return code === "BAD_REQUEST" || code === "VERSION_MISMATCH"
      ? "definitive"
      : "ambiguous";
  }
  return DEFINITIVE_STATUSES.has(status) ? "definitive" : "ambiguous";
}

//  3. Did Square actually hold the time?

export type SquareHold =
  /** ACCEPTED - the chair is genuinely taken on the seller's calendar. */
  | "held"
  /** PENDING - the booking exists but a human must accept it. NOT protection. */
  | "awaiting_seller"
  /** Cancelled, declined or no-show: the time is free again. */
  | "released"
  /** A status this code has never seen. Treated as NOT held. */
  | "unknown";

/**
 * What Square's booking status means for the chair.
 *
 * THE RULE: only ACCEPTED counts as protection. A PENDING booking is Square
 * waiting for the seller to accept, during which the slot remains bookable by
 * anyone else - so a mirror that produced PENDING rows and called the shop
 * protected would be advertising a guarantee it does not have.
 *
 * An unrecognised status is NOT held. That direction is deliberate: the cost of
 * under-claiming is a coverage report that says "check this one", and the cost
 * of over-claiming is a double booking.
 */
export function interpretBookingStatus(status: string | null | undefined): SquareHold {
  const s = (status ?? "").trim().toUpperCase();
  if (s === "ACCEPTED") return "held";
  if (s === "PENDING") return "awaiting_seller";
  if (
    s === "CANCELLED_BY_CUSTOMER" ||
    s === "CANCELLED_BY_SELLER" ||
    s === "DECLINED" ||
    s === "NO_SHOW"
  ) {
    return "released";
  }
  return "unknown";
}

/** True only when the booking Square returned genuinely holds the chair. */
export function holdsTheChair(status: string | null | undefined): boolean {
  return interpretBookingStatus(status) === "held";
}

//  4. The opaque reference

/** Prefix kept narrow so a human scanning Square can tell what made a booking. */
const REFERENCE_PREFIX = "ChairBack ref ";

/**
 * The seller note written onto a mirrored Square booking.
 *
 * Opaque ON PURPOSE, exactly as the Acuity block note is. It is visible in the
 * seller's Square dashboard and in their exports, so it carries no customer
 * name, phone, service or price - just an id that means something only inside
 * ChairBack. Unlike Acuity, it is not load-bearing for recovery (the
 * idempotency key does that job); it exists so a barber who finds an unexpected
 * booking on their calendar can tell where it came from.
 */
export function squareSellerNote(outboxId: string): string {
  return `${REFERENCE_PREFIX}${outboxId}`;
}

export function isSquareSellerNote(note: string | null | undefined): boolean {
  return typeof note === "string" && note.trim().startsWith(REFERENCE_PREFIX);
}

//  5. Self-echo

/**
 * A booking ChairBack created will come straight back as a booking.created
 * webhook. Importing it as a Visit would give the shop a phantom second
 * appointment on a chair that is already booked - the mirror double-booking
 * the very chair it was protecting.
 *
 * Membership in the outbound table is the authority, NOT the seller note: a
 * barber can edit a note, and a booking whose note was cleared is still ours.
 */
export function isSelfEcho(
  squareBookingId: string | null | undefined,
  ownedBookingIds: ReadonlySet<string>,
): boolean {
  if (!squareBookingId) return false;
  return ownedBookingIds.has(squareBookingId);
}

//  6. Occupancy span (the inbound correction)

export interface SquareSegmentLike {
  duration_minutes?: number | null;
  /** Milliseconds of gap AFTER this segment, if Square reports one. */
  intermission_minutes?: number | null;
}

/**
 * The COMPLETE occupied span of a Square booking, in minutes.
 *
 * The inbound sync read `appointment_segments[0]` and defaulted a missing
 * duration to 30 minutes. Both are wrong in the same direction - they
 * under-state how long the chair is busy - and the consequence is that
 * ChairBack offers a slot the barber is still working through.
 *
 * A cut-plus-colour booking is two segments with an intermission between them;
 * the chair is occupied for the whole thing.
 *
 * Returns null when ANY segment lacks an authoritative duration. Null is not
 * "use a default" - it means the caller must record a sync-health error and
 * withhold the availability rather than guess. Guessing is what put a customer
 * in a chair that was still busy.
 */
export function totalOccupiedMinutes(
  segments: readonly SquareSegmentLike[] | null | undefined,
): number | null {
  if (!segments || segments.length === 0) return null;
  let total = 0;
  for (const seg of segments) {
    const dur = seg.duration_minutes;
    if (typeof dur !== "number" || !Number.isFinite(dur) || dur < 0) return null;
    total += dur;
    const gap = seg.intermission_minutes;
    if (typeof gap === "number" && Number.isFinite(gap) && gap > 0) total += gap;
  }
  return total > 0 ? total : null;
}
