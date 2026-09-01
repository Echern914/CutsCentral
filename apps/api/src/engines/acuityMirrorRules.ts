/**
 * THE DECISIONS behind mirroring ChairBack occupancy out to Acuity, kept pure
 * so every branch is provable without a database or a network.
 *
 * Context: Acuity sync only ever ran inbound. A shop on native booking whose
 * Acuity page is still live has two front doors onto one chair, and Acuity
 * cannot see ChairBack's bookings - a ChairBack appointment held 6:10-6:30pm
 * for eleven days and Acuity sold 5:40-6:20pm over it. Three questions decide
 * everything downstream, and getting any of them wrong is worse than not
 * mirroring at all:
 *
 *   1. Is this shop eligible?           -> isMirrorEligible
 *   2. Does this appointment occupy the chair right now? -> appointmentOccupiesTime
 *   3. Did that failed call maybe still create a block?  -> classifyFailure
 */

import type { AcuityOutboundMode } from "@chairback/db";

//  1. Eligibility

export interface MirrorShopSlice {
  bookingMode: string;
  acuityOutboundMode: AcuityOutboundMode;
  /** Whether an AcuityConnection row exists for the shop. */
  acuityConnected: boolean;
}

export type MirrorAction = "create" | "release";

/**
 * May we act on this shop, for this kind of action?
 *
 * CREATE is gated hard: native booking, a live connection, and mode ENFORCE.
 * OBSERVE evaluates and reports but never writes (see shouldObserve).
 *
 * RELEASE is deliberately NOT gated on the mode. A block ChairBack already
 * created belongs to ChairBack, and switching a shop OFF must never strand it
 * on the barber's Acuity calendar - "we stopped mirroring" cannot be allowed
 * to mean "your Tuesday is blocked forever with no way to clear it". Releases
 * and reconciliation keep running in every mode, OFF included, for as long as
 * the connection exists.
 */
export function isMirrorEligible(
  shop: MirrorShopSlice,
  action: MirrorAction,
): boolean {
  if (!shop.acuityConnected) return false;
  if (action === "release") return true;
  return shop.bookingMode === "native" && shop.acuityOutboundMode === "ENFORCE";
}

/** OBSERVE: compute and log the intended call, perform no Acuity write. */
export function shouldObserve(shop: MirrorShopSlice): boolean {
  return (
    shop.acuityConnected &&
    shop.bookingMode === "native" &&
    shop.acuityOutboundMode === "OBSERVE"
  );
}

//  2. Occupancy

export interface OccupancySlice {
  status: "PENDING" | "BOOKED" | "CANCELED" | "COMPLETED" | "NO_SHOW";
  startsAt: Date;
  endsAt: Date;
  /**
   * Set on a HOLD - a PENDING row that lapses on its own. A pending APPROVAL
   * REQUEST has this null and waits indefinitely.
   */
  holdExpiresAt: Date | null;
  /**
   * WHICH kind of hold. null = the AI receptionist's (and every row from
   * before the column existed); "payment" = a customer on the checkout screen.
   * Read by shouldMirrorOnCreate and nowhere else - see the note there.
   *
   * Optional on the interface because several callers build this slice from a
   * hand-written `select` and a missing field must read as "receptionist",
   * which is the pre-existing behaviour.
   */
  holdReason?: string | null;
  /**
   * The synced Visit this appointment was promoted from, if any. A linked row
   * is Acuity's OWN booking reflected inward; mirroring it back out would
   * block the barber's real Acuity appointment with a duplicate of itself.
   */
  visitId: string | null;
}

/**
 * Does this appointment physically own its chair right now?
 *
 * ONE definition, used by the outbox writer and the reconciler alike, so
 * "what we mirror" and "what we release" can never drift apart.
 *
 * Status alone is not enough, and that is the subtle part:
 *
 *  - A WALK-IN is stored COMPLETED at creation, because the money is already
 *    in the till - but the client is in the chair for the next 20 minutes.
 *    Treating COMPLETED as free would offer that time in Acuity while the
 *    clippers are running. So a COMPLETED row still occupies until its span
 *    ends.
 *  - A PENDING approval REQUEST occupies indefinitely (it holds the slot in
 *    ChairBack, so it must hold it in Acuity too).
 *  - A PENDING receptionist HOLD is minutes long and lapses on its own; it is
 *    excluded by the caller, not here (see shouldMirrorOnCreate) - this
 *    predicate answers only "is the chair busy", and an unexpired hold is.
 *  - CANCELED and NO_SHOW free the chair immediately, at any time.
 */
export function appointmentOccupiesTime(appt: OccupancySlice, now: Date): boolean {
  if (appt.visitId !== null) return false; // Acuity's own booking, mirrored inward
  if (appt.status === "CANCELED" || appt.status === "NO_SHOW") return false;
  // An EXPIRED hold released its slot the moment it lapsed - the sweep that
  // flips it to CANCELED is hygiene, not correctness (same rule the booking
  // guard applies).
  if (appt.holdExpiresAt !== null && appt.holdExpiresAt.getTime() <= now.getTime()) {
    return false;
  }
  // Past its end: the chair is free regardless of status. This is what stops
  // the mirror re-blocking yesterday.
  if (appt.endsAt.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * Should CREATING this appointment mirror out?
 *
 * Ephemeral RECEPTIONIST holds are skipped by design: they are minutes long,
 * lapse without an explicit action, and would multiply outbound writes against
 * an unknown Acuity rate limit for time that is usually released before a
 * customer could ever have booked it. An indefinite approval request is the
 * opposite case and IS mirrored.
 *
 * A PAYMENT hold is mirrored, and that is the one exception. It looks
 * identical in the schema - PENDING with a holdExpiresAt minutes away - but it
 * is not speculative: a real customer is on the checkout screen right now with
 * their card out. Leaving that chair open in Acuity for the length of a card
 * payment is precisely how a ChairBack booking that had held 6:10pm got sold
 * over from the Acuity side. The block is released when the hold lapses
 * (services/appointmentPaymentHold.ts) exactly as it is on any cancellation.
 */
export function shouldMirrorOnCreate(appt: OccupancySlice, now: Date): boolean {
  // Ephemeral hold, and not the one kind we defend.
  if (appt.holdExpiresAt !== null && appt.holdReason !== "payment") return false;
  return appointmentOccupiesTime(appt, now);
}

//  3. Failure classification

/**
 * DEFINITIVE  Acuity answered, and the answer proves no block was created
 *             (validation rejected it, or auth/permission refused it). Safe to
 *             mark FAILED and compensate.
 * AMBIGUOUS   We did not get a usable answer. The block MAY exist. Never
 *             compensate, never blind-retry - mark UNKNOWN and let the
 *             reconciler look for it by reference.
 */
export type FailureKind = "definitive" | "ambiguous";

/**
 * Anything that is not a proven rejection is ambiguous.
 *
 * 408/429/5xx and every transport error (timeout, reset, DNS, TLS) can all
 * follow a request Acuity actually processed - a gateway timeout in
 * particular is the classic "created it, lost the response". 429 is included
 * deliberately: some rate limiters reject before the handler and some after.
 *
 * Only 400/401/403/404/409/422 are treated as definitive, and only because
 * each of those means Acuity looked at the request and declined to act.
 */
const DEFINITIVE_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

export function classifyFailure(status: number | null): FailureKind {
  if (status === null) return "ambiguous"; // transport-level: no answer at all
  if (status === 408 || status === 429) return "ambiguous";
  if (status >= 500) return "ambiguous";
  return DEFINITIVE_STATUSES.has(status) ? "definitive" : "ambiguous";
}

//  4. The opaque reference

/** Prefix kept narrow so a human scanning Acuity can tell what made a block. */
const REFERENCE_PREFIX = "ChairBack ref ";

/**
 * The note written onto an Acuity block: a prefix plus the outbox row id.
 *
 * Opaque ON PURPOSE. It is visible in the barber's Acuity UI and in Acuity's
 * own exports, so it carries no customer name, phone, service or price - just
 * an id that means something only inside ChairBack. It is also the ONLY way to
 * recover an ambiguous create, since Acuity offers no idempotency key.
 */
export function blockReference(outboxId: string): string {
  return `${REFERENCE_PREFIX}${outboxId}`;
}

/** True when this Acuity block's note is exactly our reference for that row. */
export function matchesReference(note: string | null | undefined, outboxId: string): boolean {
  if (typeof note !== "string") return false;
  return note.trim() === blockReference(outboxId);
}

/**
 * Recover an ambiguous create: is THIS Acuity block the one our row asked for?
 *
 * Exact reference AND calendar AND span - never fuzzy note matching. Two
 * appointments on one calendar can share a span (a barber double-booking
 * himself deliberately), and two rows can share a span across calendars, so
 * only the reference makes it unique; the calendar and span are corroboration
 * that stops a mangled or recycled note from claiming the wrong block.
 */
export function isRecoveryMatch(
  candidate: {
    notes?: string | null;
    description?: string | null;
    calendarID?: string | null;
    startsAt: Date | null;
    endsAt: Date | null;
  },
  want: { outboxId: string; calendarId: string; startsAt: Date; endsAt: Date },
): boolean {
  const note = candidate.notes ?? candidate.description ?? null;
  if (!matchesReference(note, want.outboxId)) return false;
  if (String(candidate.calendarID ?? "") !== want.calendarId) return false;
  if (!candidate.startsAt || !candidate.endsAt) return false;
  return (
    candidate.startsAt.getTime() === want.startsAt.getTime() &&
    candidate.endsAt.getTime() === want.endsAt.getTime()
  );
}
