/* AFFILIATE COMMISSION LEDGER (v2 program, PR 1 of 3).

   For every base-plan invoice a referred business pays in its first 12
   months, the affiliate earns a commission line: 20% if they chose cash, 30%
   if they chose ChairBack bill credit. Lines are HELD for 30 days and become
   AVAILABLE only after that AND the business's second paid base invoice.

   🔴 NOTHING HERE MOVES MONEY. This is the earnings ledger only; payout and
   credit execution are later phases. Everything stays dark behind
   AFFILIATE_COMMISSIONS_ENABLED (plus the program + qualification flags).

   Idempotent throughout, so a second run is a no-op. */

/* ------------------------------------------------------------------ *
 * 1. THE AFFILIATE'S CHOICE: cash or credit
 *
 * Defaults to 'credit' - what v1 paid - so no existing account is moved
 * onto cash without choosing it. Read at earn time and frozen onto each
 * commission line; changing it never rewrites history.
 * ------------------------------------------------------------------ */
ALTER TABLE "AffiliateAccount"
  ADD COLUMN IF NOT EXISTS "payoutPreference" TEXT NOT NULL DEFAULT 'credit',
  ADD COLUMN IF NOT EXISTS "payoutPreferenceSetAt" TIMESTAMP(3);

ALTER TABLE "AffiliateAccount"
  DROP CONSTRAINT IF EXISTS "AffiliateAccount_payoutPreference_check";
ALTER TABLE "AffiliateAccount"
  ADD CONSTRAINT "AffiliateAccount_payoutPreference_check"
  CHECK ("payoutPreference" IN ('credit', 'cash'));

/* ------------------------------------------------------------------ *
 * 2. THE LEDGER
 * ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS "AffiliateCommission" (
  "id"                 TEXT NOT NULL,
  "affiliateAccountId" TEXT NOT NULL,
  "referredShopId"     TEXT NOT NULL,
  "stripeInvoiceId"    TEXT NOT NULL,
  "baseAmountCents"    INTEGER NOT NULL,
  "rateBps"            INTEGER NOT NULL,
  "amountCents"        INTEGER NOT NULL,
  "currency"           TEXT NOT NULL,
  "kind"               TEXT NOT NULL,
  "status"             TEXT NOT NULL DEFAULT 'HELD',
  "earnedAt"           TIMESTAMP(3) NOT NULL,
  "holdEndsAt"         TIMESTAMP(3) NOT NULL,
  "availableAt"        TIMESTAMP(3),
  "reversedAt"         TIMESTAMP(3),
  "reversalReason"     TEXT,
  "clawbackDueAt"      TIMESTAMP(3),
  "payoutId"           TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AffiliateCommission_pkey" PRIMARY KEY ("id")
);

/* 🔴 One commission per INVOICE, ever. Stripe redelivers events for days and
   emits more than one event about the same invoice; this index, not an
   application check, is what makes both of those earn once. */
CREATE UNIQUE INDEX IF NOT EXISTS "AffiliateCommission_stripeInvoiceId_key"
  ON "AffiliateCommission"("stripeInvoiceId");
CREATE INDEX IF NOT EXISTS "AffiliateCommission_affiliateAccountId_status_idx"
  ON "AffiliateCommission"("affiliateAccountId", "status");
CREATE INDEX IF NOT EXISTS "AffiliateCommission_status_holdEndsAt_idx"
  ON "AffiliateCommission"("status", "holdEndsAt");
CREATE INDEX IF NOT EXISTS "AffiliateCommission_referredShopId_idx"
  ON "AffiliateCommission"("referredShopId");

ALTER TABLE "AffiliateCommission" DROP CONSTRAINT IF EXISTS "AffiliateCommission_kind_check";
ALTER TABLE "AffiliateCommission" ADD CONSTRAINT "AffiliateCommission_kind_check"
  CHECK ("kind" IN ('cash', 'credit'));
ALTER TABLE "AffiliateCommission" DROP CONSTRAINT IF EXISTS "AffiliateCommission_status_check";
ALTER TABLE "AffiliateCommission" ADD CONSTRAINT "AffiliateCommission_status_check"
  CHECK ("status" IN ('HELD', 'AVAILABLE', 'REVIEW_REQUIRED', 'PAID', 'REVERSED'));
ALTER TABLE "AffiliateCommission" DROP CONSTRAINT IF EXISTS "AffiliateCommission_reversalReason_check";
ALTER TABLE "AffiliateCommission" ADD CONSTRAINT "AffiliateCommission_reversalReason_check"
  CHECK ("reversalReason" IS NULL OR "reversalReason" IN
    ('invoice_refunded', 'payment_disputed', 'credit_note', 'admin_adjustment'));
/* Money is never zero or negative here. */
ALTER TABLE "AffiliateCommission" DROP CONSTRAINT IF EXISTS "AffiliateCommission_amount_check";
ALTER TABLE "AffiliateCommission" ADD CONSTRAINT "AffiliateCommission_amount_check"
  CHECK ("amountCents" > 0 AND "baseAmountCents" > 0);
/* A rate, not a policy: the percentages live in AFFILIATE_POLICY and may
   change without a migration, but no line may ever pay out more than the
   invoice it came from. */
ALTER TABLE "AffiliateCommission" DROP CONSTRAINT IF EXISTS "AffiliateCommission_rate_check";
ALTER TABLE "AffiliateCommission" ADD CONSTRAINT "AffiliateCommission_rate_check"
  CHECK ("rateBps" > 0 AND "rateBps" <= 10000);
/* A reversed line says when and why. */
ALTER TABLE "AffiliateCommission" DROP CONSTRAINT IF EXISTS "AffiliateCommission_reversed_shape_check";
ALTER TABLE "AffiliateCommission" ADD CONSTRAINT "AffiliateCommission_reversed_shape_check"
  CHECK ("status" <> 'REVERSED' OR ("reversedAt" IS NOT NULL AND "reversalReason" IS NOT NULL));
/* Nothing is available or paid without having been released. */
ALTER TABLE "AffiliateCommission" DROP CONSTRAINT IF EXISTS "AffiliateCommission_available_shape_check";
ALTER TABLE "AffiliateCommission" ADD CONSTRAINT "AffiliateCommission_available_shape_check"
  CHECK ("status" NOT IN ('AVAILABLE', 'PAID') OR "availableAt" IS NOT NULL);

/* 🔴 DEFAULT-DENY, same as every other affiliate and platform table: revoke
   explicitly (ALTER DEFAULT PRIVILEGES already granted everything), then
   force RLS with no policies. Read and written only on the owner path. */
REVOKE ALL ON "AffiliateCommission" FROM chairback_app;
ALTER TABLE "AffiliateCommission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AffiliateCommission" FORCE ROW LEVEL SECURITY;

/* ------------------------------------------------------------------ *
 * 3. THE AUDIT VOCABULARY gains the commission events. Re-pinned in FULL -
 *    never a partial list - so nothing an earlier phase writes stops passing.
 * ------------------------------------------------------------------ */
ALTER TABLE "AffiliateAuditEvent"
  DROP CONSTRAINT IF EXISTS "AffiliateAuditEvent_type_check";
ALTER TABLE "AffiliateAuditEvent"
  ADD CONSTRAINT "AffiliateAuditEvent_type_check"
  CHECK ("type" IN (
    'application.submitted', 'application.approved', 'application.rejected',
    'account.suspended', 'account.reactivated', 'account.styles_set',
    'attribution.locked', 'attribution.corrected', 'attribution.superseded_by_legacy',
    'reward.qualified', 'reward.available', 'reward.reversed',
    'reward.expired', 'reward.review_flagged',
    'credit.applied', 'credit.adjusted',
    'commission.earned', 'commission.review_flagged', 'commission.available',
    'commission.reversed', 'commission.clawback_due'
  ));

/* ------------------------------------------------------------------ *
 * 4. The hold-release job. A scheduled job whose name has no job_lease row
 *    NEVER runs - withLease acquires by UPDATE only.
 * ------------------------------------------------------------------ */
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt")
VALUES ('affiliate-commission-hold', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
