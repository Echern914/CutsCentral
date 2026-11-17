/* ------------------------------------------------------------------ *
 * Two days, then locked: a declined subscription charge
 * (billing/stripe.ts hasActiveAccess, PAST_DUE_GRACE_MS).
 * ------------------------------------------------------------------ */

-- 1. When the base subscription went past_due. Null = not past_due.
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "pastDueSince" TIMESTAMP(3);

-- 2. A shop that is ALREADY past_due when this ships starts its two days
--    now, not from a decline we never recorded: nobody is locked on deploy.
UPDATE "Shop"
SET "pastDueSince" = now()
WHERE "subscriptionStatus" = 'past_due'
  AND "pastDueSince" IS NULL;
