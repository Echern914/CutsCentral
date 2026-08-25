import { Prisma, prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { ingestSquareBooking } from "./ingest.js";
import {
  claimSquareBookingByNote,
  lastAppliedSquareBookingVersion,
  ownedSquareBookingIds,
  reconcileOwnedBookingFromWebhook,
} from "../engines/squareMirror.js";
import { isSelfEcho, squareEventAdvances } from "../engines/squareMirrorRules.js";

/**
 * THE WEBHOOK INBOX.
 *
 * The old handler ingested first and acknowledged second, leaning on the Visit
 * upsert being idempotent. That dedupes ROWS, not WORK: a redelivered
 * booking.updated still re-fetched the booking, re-fetched the customer,
 * re-ran the punch pipeline and could re-send a notification. Square retries on
 * any 5xx and reorders freely, so "idempotent enough" was doing a lot of work.
 *
 * The ledger makes Square's own `event_id` the key of the work itself:
 *
 *   1. verify the HMAC (caller, before anything else)
 *   2. INSERT the event - a duplicate collides on the unique index and costs
 *      one failed insert instead of a full replay
 *   3. acknowledge promptly, so Square's retry budget is not spent waiting on
 *      our processing
 *   4. process, and record the outcome on the ledger row
 *
 * A row that never reaches PROCESSED is the retry queue. Nothing is lost by
 * acknowledging early, because the durable record was written first.
 */

export type InboxAdmission =
  /** New event, persisted, ours to process. */
  | { kind: "accepted"; rowId: string }
  /** Seen before. Do nothing at all. */
  | { kind: "duplicate" }
  /** Nothing actionable (no event id, or an event type we do not handle). */
  | { kind: "ignored" };

/**
 * Persist an event, or report that we have already seen it.
 *
 * The unique index on eventId is the authority, not a read-then-write check:
 * Square can and does deliver the same event twice in the same second, and two
 * workers checking-then-inserting would both pass the check.
 */
export async function admitEvent(input: {
  eventId: string | null | undefined;
  merchantId: string | null | undefined;
  type: string | null | undefined;
  bookingId: string | null | undefined;
  bookingVersion?: number | null;
}): Promise<InboxAdmission> {
  if (!input.eventId) {
    // No event id means no idempotency key. Handling it would reintroduce the
    // exact replay problem this table exists to remove, so it is ignored and
    // acknowledged - Square stops retrying, and nothing partial happened.
    logger.warn({ type: input.type }, "square webhook without an event_id - ignoring");
    return { kind: "ignored" };
  }
  try {
    const row = await prisma.squareWebhookEvent.create({
      data: {
        eventId: input.eventId,
        merchantId: input.merchantId ?? null,
        type: input.type ?? null,
        bookingId: input.bookingId ?? null,
        bookingVersion: input.bookingVersion ?? null,
      },
      select: { id: true },
    });
    return { kind: "accepted", rowId: row.id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { kind: "duplicate" };
    }
    throw err;
  }
}

/** Mark a ledger row done, with a sanitized reason when it is not. */
export async function settleEvent(
  rowId: string,
  status: "PROCESSED" | "IGNORED" | "FAILED",
  fields: { shopId?: string | null; lastError?: string | null } = {},
): Promise<void> {
  await prisma.squareWebhookEvent.update({
    where: { id: rowId },
    data: {
      status,
      processedAt: new Date(),
      attempts: { increment: 1 },
      ...(fields.shopId !== undefined ? { shopId: fields.shopId } : {}),
      ...(fields.lastError !== undefined ? { lastError: fields.lastError } : {}),
    },
  });
}

/**
 * Handle one booking event for a resolved shop.
 *
 * SELF-ECHO IS CHECKED FIRST. A booking ChairBack created comes straight back
 * as booking.created; importing it as a Visit would give the shop a phantom
 * second appointment on a chair that is already booked - the mirror
 * double-booking the very chair it was protecting.
 *
 * It is checked TWICE, against two different identifiers, because neither alone
 * covers the whole life of a mirrored booking:
 *
 *   1. THE OUTBOUND TABLE, which is the durable authority. A barber can edit
 *      or clear the seller note and the booking is still ours, so membership
 *      here is what survives.
 *   2. THE SELLER NOTE, which covers the window the table cannot: between
 *      Square accepting the create and ChairBack storing the returned id,
 *      there IS no id to match on, and Square's webhook routinely arrives
 *      first. The note is written before Square ever sees the booking, and a
 *      live sandbox delivery confirmed it comes back in the payload.
 *
 * The note is a claim, never proof - claimSquareBookingByNote only honours one
 * that names a real outbox row belonging to THIS shop.
 *
 * When the barber later edits or cancels one of OUR bookings inside Square,
 * that is reconciled against the linked ChairBack appointment - never turned
 * into a Visit.
 */
export async function processBookingEvent(
  shop: { id: string } & Record<string, unknown>,
  bookingId: string,
  status: string | null | undefined,
  sellerNote?: string | null,
  version: number | null = null,
): Promise<"self_echo" | "ingested" | "stale"> {
  // ORDER. Square does not guarantee delivery order, and this handler acts on
  // the envelope's status rather than re-reading the booking, so a late arrival
  // describing an older state would overwrite a newer one - a stale ACCEPTED
  // landing after a cancellation repaints an unprotected chair as protected.
  //
  // Fails OPEN: an unknown version on either side processes normally, because
  // dropping an event we cannot order is worse than processing one twice, which
  // the event_id ledger already absorbs.
  const applied = await lastAppliedSquareBookingVersion(shop.id, bookingId);
  if (!squareEventAdvances(version, applied)) {
    logger.info(
      { shopId: shop.id, squareBookingId: bookingId, version, applied },
      "square webhook: event describes an older state than one already applied - dropped",
    );
    return "stale";
  }

  const owned = await ownedSquareBookingIds(shop.id);
  if (isSelfEcho(bookingId, owned)) {
    await reconcileOwnedBookingFromWebhook(shop.id, bookingId, status, version);
    logger.info(
      { shopId: shop.id, squareBookingId: bookingId },
      "square webhook: our own mirrored booking - reconciled, not imported",
    );
    return "self_echo";
  }

  // THE RACE. Square fires booking.created the instant it accepts the write,
  // which routinely beats dispatchSquareCreate storing the returned id - and
  // ownedSquareBookingIds only sees rows that HAVE an id. Inside that window
  // the sole evidence the booking is ours is the note we wrote before Square
  // ever saw it. Verified against a live sandbox delivery: the payload does
  // carry seller_note.
  //
  // Without this, the mirror imports its own booking as a Visit - a phantom
  // second appointment on the chair it was protecting.
  if (await claimSquareBookingByNote(shop.id, sellerNote, bookingId)) {
    await reconcileOwnedBookingFromWebhook(shop.id, bookingId, status, version);
    logger.info(
      { shopId: shop.id, squareBookingId: bookingId },
      "square webhook: our own booking, claimed by seller note before the id was stored",
    );
    return "self_echo";
  }

  await ingestSquareBooking(shop as never, bookingId);
  return "ingested";
}
