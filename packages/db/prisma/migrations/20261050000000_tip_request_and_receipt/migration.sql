-- Tips, part 3: the "Leave a tip" email, the client's receipt, the staff push.

-- One "Leave a tip" email per visit: the sweep's claim.
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "tipRequestSentAt" TIMESTAMP(3);

-- The SHOP completed the visit (Done, checkout, walk-in Complete), as opposed
-- to the 15-minute sweep completing it on its own - which an unmarked no-show
-- also does. Only a visit the shop finished is asked for a tip. Visits that
-- completed before this deploy stay false; the ask only looks back hours.
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "completedByShop" BOOLEAN NOT NULL DEFAULT false;

-- One announcement (receipt + staff push) per paid tip: the claim.
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "tipAnnouncedAt" TIMESTAMP(3);

-- Tips paid before this deploy are never announced late.
UPDATE "Payment" SET "tipAnnouncedAt" = "updatedAt"
 WHERE "purpose" = 'tip'
   AND "tipAnnouncedAt" IS NULL
   AND "status" IN ('succeeded', 'partially_refunded', 'refunded');

-- The email kinds, re-pinned in FULL (the eight before + two). The status
-- CHECK is untouched.
ALTER TABLE "EmailIntent"
  DROP CONSTRAINT IF EXISTS "EmailIntent_kind_check";
ALTER TABLE "EmailIntent"
  ADD CONSTRAINT "EmailIntent_kind_check"
  CHECK ("kind" IN (
    'appointment_canceled',
    'affiliate_approved',
    'affiliate_rejected',
    'affiliate_reward_qualified',
    'affiliate_reward_available',
    'affiliate_reward_reversed',
    'group_confirmation',
    'service_charge_receipt',
    'tip_request',
    'tip_receipt'
  ));
