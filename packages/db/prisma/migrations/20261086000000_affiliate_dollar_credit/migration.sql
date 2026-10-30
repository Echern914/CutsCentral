/* AFFILIATE DOLLAR CREDIT (policy v3, owner decision 2026-10-30).

   Rewards become ACCOUNT CREDIT IN DOLLARS on the affiliate's own ChairBack
   bill - never cash: $10 when a referred business pays its first base-plan
   invoice, then $5 for every later paid month. A month off per business (the
   v1 program) stays as the alternative style.

   Each dollar credit is an AffiliateReward row tied to the ONE Stripe invoice
   that earned it, and is applied by the existing AffiliateCreditOperation
   outbox (key affiliate-reward:<rewardId>), exactly like a month off.

   🔴 NOTHING HERE MOVES MONEY, and nothing changes for anyone while the
   affiliate flags are off. Idempotent throughout: a second run is a no-op. */

/* ------------------------------------------------------------------ *
 * 1. THE AFFILIATE'S CHOICE: dollar credit or a month off.
 *
 * Existing accounts accepted terms that promised a month off, so they are
 * backfilled to 'month_off' and keep it until they choose otherwise. NEW
 * accounts default to 'dollar_credit'. (ADD COLUMN with the old default fills
 * existing rows; the default is then moved for rows created from now on.)
 * ------------------------------------------------------------------ */
ALTER TABLE "AffiliateAccount"
  ADD COLUMN IF NOT EXISTS "rewardStyle" TEXT NOT NULL DEFAULT 'month_off',
  ADD COLUMN IF NOT EXISTS "rewardStyleSetAt" TIMESTAMP(3);
ALTER TABLE "AffiliateAccount" ALTER COLUMN "rewardStyle" SET DEFAULT 'dollar_credit';

ALTER TABLE "AffiliateAccount"
  DROP CONSTRAINT IF EXISTS "AffiliateAccount_rewardStyle_check";
ALTER TABLE "AffiliateAccount"
  ADD CONSTRAINT "AffiliateAccount_rewardStyle_check"
  CHECK ("rewardStyle" IN ('dollar_credit', 'month_off'));

/* ------------------------------------------------------------------ *
 * 2. THE REWARD LEDGER holds more than one reward per referred business.
 * ------------------------------------------------------------------ */
ALTER TABLE "AffiliateReward" ADD COLUMN IF NOT EXISTS "stripeInvoiceId" TEXT;

/* 🔴 One dollar credit per Stripe INVOICE, ever. Stripe redelivers events for
   days, out of order, and emits more than one event about the same invoice;
   this index, not an application check, is what makes all of that earn once.
   Month-off rewards carry NULL here, and NULLs never collide. */
CREATE UNIQUE INDEX IF NOT EXISTS "AffiliateReward_stripeInvoiceId_key"
  ON "AffiliateReward"("stripeInvoiceId");

/* "One reward per referred shop, ever" becomes "one BRING-ON reward per
   referred shop, ever": a month off OR the sign-up credit, never both and
   never two. Later monthly credits are many per shop by design. */
DROP INDEX IF EXISTS "AffiliateReward_referredShopId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "AffiliateReward_bringOn_referredShopId_key"
  ON "AffiliateReward"("referredShopId")
  WHERE "rewardType" IN ('subscription_credit', 'signup_credit');
CREATE INDEX IF NOT EXISTS "AffiliateReward_referredShopId_idx"
  ON "AffiliateReward"("referredShopId");

/* attributionId was unique only because rewards were one per shop. */
DROP INDEX IF EXISTS "AffiliateReward_attributionId_key";
CREATE INDEX IF NOT EXISTS "AffiliateReward_attributionId_idx"
  ON "AffiliateReward"("attributionId");

ALTER TABLE "AffiliateReward" DROP CONSTRAINT IF EXISTS "AffiliateReward_rewardType_check";
ALTER TABLE "AffiliateReward" ADD CONSTRAINT "AffiliateReward_rewardType_check"
  CHECK ("rewardType" IN ('subscription_credit', 'signup_credit', 'monthly_credit'));

/* A dollar credit always names the invoice that earned it - that is what a
   refund reverses, and what the unique key above counts. */
ALTER TABLE "AffiliateReward" DROP CONSTRAINT IF EXISTS "AffiliateReward_dollar_invoice_check";
ALTER TABLE "AffiliateReward" ADD CONSTRAINT "AffiliateReward_dollar_invoice_check"
  CHECK ("rewardType" = 'subscription_credit' OR "stripeInvoiceId" IS NOT NULL);

/* ------------------------------------------------------------------ *
 * 3. THE AUDIT VOCABULARY gains the reward-style choice. Re-pinned in FULL -
 *    never a partial list - so nothing an earlier phase writes stops passing.
 * ------------------------------------------------------------------ */
ALTER TABLE "AffiliateAuditEvent"
  DROP CONSTRAINT IF EXISTS "AffiliateAuditEvent_type_check";
ALTER TABLE "AffiliateAuditEvent"
  ADD CONSTRAINT "AffiliateAuditEvent_type_check"
  CHECK ("type" IN (
    'application.submitted', 'application.approved', 'application.rejected',
    'account.suspended', 'account.reactivated', 'account.styles_set',
    'account.reward_style_set',
    'attribution.locked', 'attribution.corrected', 'attribution.superseded_by_legacy',
    'reward.qualified', 'reward.available', 'reward.reversed',
    'reward.expired', 'reward.review_flagged',
    'credit.applied', 'credit.adjusted',
    'commission.earned', 'commission.review_flagged', 'commission.available',
    'commission.reversed', 'commission.clawback_due'
  ));
