import { Prisma, prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { ingestSquareBooking } from "./ingest.js";
import {
  ownedSquareBookingIds,
  reconcileOwnedBookingFromWebhook,
} from "../engines/squareMirror.js";
import { isSelfEcho } from "../engines/squareMirrorRules.js";

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
 * SELF-ECHO IS CHECKED FIRST, and against the outbound table rather than
 * against the seller note. A booking ChairBack created comes straight back as
 * booking.created; importing it as a Visit would give the shop a phantom second
 * appointment on a chair that is already booked - the mirror double-booking the
 * very chair it was protecting. The note is not the authority because a barber
 * can edit it, and a booking whose note was cleared is still ours.
 *
 * When the barber later edits or cancels one of OUR bookings inside Square,
 * that is reconciled against the linked ChairBack appointment - never turned
 * into a Visit.
 */
export async function processBookingEvent(
  shop: { id: string } & Record<string, unknown>,
  bookingId: string,
  status: string | null | undefined,
): Promise<"self_echo" | "ingested"> {
  const owned = await ownedSquareBookingIds(shop.id);
  if (isSelfEcho(bookingId, owned)) {
    await reconcileOwnedBookingFromWebhook(shop.id, bookingId, status);
    logger.info(
      { shopId: shop.id, squareBookingId: bookingId },
      "square webhook: our own mirrored booking - reconciled, not imported",
    );
    return "self_echo";
  }
  await ingestSquareBooking(shop as never, bookingId);
  return "ingested";
}
