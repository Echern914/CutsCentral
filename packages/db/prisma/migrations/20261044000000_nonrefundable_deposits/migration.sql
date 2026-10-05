-- A shop can make its booking deposit non-refundable when the CLIENT cancels.
--
-- Shop.depositNonRefundable is the switch (deposit mode only), OFF by default:
-- every existing shop keeps following its cancellation policy until an owner
-- chooses otherwise.
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "depositNonRefundable" BOOLEAN NOT NULL DEFAULT false;

-- Payment.nonRefundable is the TERMS THE BOOKING WAS PAID ON, snapshotted when
-- the booking payment is reserved and never rewritten, so the shop changing its
-- switch never changes a booking already made. Every existing payment reads
-- false - refundable, exactly as it was taken.
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "nonRefundable" BOOLEAN NOT NULL DEFAULT false;

-- Only the money taken AT BOOKING can carry it. A no-show fee, a late-cancel
-- fee or a balance collected after the visit is never "a deposit".
ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_nonRefundable_booking_check";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_nonRefundable_booking_check"
  CHECK ("nonRefundable" = false OR "purpose" = 'booking');

-- No index on either: both are read only on rows already loaded by key.
