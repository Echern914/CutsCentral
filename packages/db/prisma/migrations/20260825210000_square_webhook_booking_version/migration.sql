-- Square does not guarantee webhook delivery order.
--
-- The envelope's `data.id` is "<bookingId>:<version>", not the bare booking id
-- (measured against a live sandbox delivery, 2026-08-25). Storing the parsed
-- version is what lets a late arrival be recognised as describing an OLDER
-- state of a booking than one already applied.
--
-- This matters most on the owned-mirror path: reconcileOwnedBookingFromWebhook
-- writes squareBookingStatus straight from the envelope, so a stale ACCEPTED
-- landing after a CANCELLED_BY_SELLER would repaint an unprotected chair as
-- protected.

ALTER TABLE "SquareWebhookEvent"
  ADD COLUMN IF NOT EXISTS "bookingVersion" INTEGER;

-- "what is the newest version of this booking we have already applied?"
CREATE INDEX IF NOT EXISTS "SquareWebhookEvent_shopId_bookingId_bookingVersion_idx"
  ON "SquareWebhookEvent"("shopId", "bookingId", "bookingVersion");
