-- The affiliate program's five emails ride the same durable outbox as the
-- cancellation email. EmailIntent.kind is CHECK-pinned, so the vocabulary is
-- re-pinned here in FULL - never a partial list - and nothing about the
-- existing kind changes. The status CHECK is untouched.
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
    'affiliate_reward_reversed'
  ));
