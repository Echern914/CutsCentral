-- A Payment row can now be a TIP: money a client leaves on top of the price,
-- after the visit. This migration only teaches the database what a tip row is
-- and what it may never be; no code writes one yet.
--
-- Additive: no existing row changes meaning, and every existing row already
-- satisfies every constraint below (none has purpose 'tip').

-- 1. The purpose list gains 'tip'. Re-listed in full, as every earlier change
--    to this CHECK did (20261003000000_service_checkout).
ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_purpose_check";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_purpose_check"
  CHECK ("purpose" IN ('booking', 'fee', 'service_checkout', 'tip'));

-- 2. ONE TIP PER VISIT. At most one tip row per appointment that is still
--    alive. A tip whose intent was abandoned and cancelled, or that never
--    reached Stripe (failed), frees the visit for a fresh attempt; a refunded
--    tip does NOT - the owner's rule is one tip per visit, with no second tip
--    after a refund. The reservation insert is the lock, exactly as
--    "Payment_appointmentId_booking_key" is for a deposit.
CREATE UNIQUE INDEX IF NOT EXISTS "Payment_appointmentId_tip_live_key"
  ON "Payment"("appointmentId")
  WHERE "purpose" = 'tip' AND "status" NOT IN ('failed', 'canceled');

-- 3. A tip is a payment the client confirms themselves ('ahead'). Never
--    'card_on_file': the reconciler reads that mode as a no-show fee and would
--    flip the visit's card-on-file record and raise a false card alert.
ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_tip_mode_check";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tip_mode_check"
  CHECK ("purpose" <> 'tip' OR "mode" = 'ahead');

-- 4. The fee taken back from a tip covers Stripe's processing fee and nothing
--    more (the owner's rule: the fee comes out of the tip, ChairBack keeps
--    none of it). It can never be negative or swallow the whole tip.
ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_tip_fee_check";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tip_fee_check"
  CHECK ("purpose" <> 'tip' OR ("applicationFeeAmount" >= 0 AND "applicationFeeAmount" < "amount"));
