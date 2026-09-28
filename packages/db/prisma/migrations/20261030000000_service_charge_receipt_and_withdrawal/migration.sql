/* THE SERVICE-CHARGE CONSENT KEEPS ITS LAST TWO PROMISES.

   The v1 wording a customer ticks to let a shop charge their saved card for
   the service says "You will get a receipt by email every time" and "you can
   remove this card at any time from your appointment link". Both are made
   true here rather than the words changed, so every consent already given
   stays honest.

   1. CardOnFile."serviceChargeWithdrawnAt" - the moment the customer took the
      permission back. Nullable and additive. The consent columns themselves
      are never cleared: they are the record of what was agreed and when, and
      any charge already taken rests on them.

   2. EmailIntent.kind gains 'service_charge_receipt'. The vocabulary is
      CHECK-pinned, so it is re-pinned in FULL - never a partial list - and
      nothing about the existing kinds changes. The status CHECK is untouched.
*/

ALTER TABLE "CardOnFile" ADD COLUMN "serviceChargeWithdrawnAt" TIMESTAMP(3);

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
    'service_charge_receipt'
  ));
