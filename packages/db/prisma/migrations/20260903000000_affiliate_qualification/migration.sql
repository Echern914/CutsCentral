/* AFFILIATE QUALIFICATION (arc phase 3), plus the cross-ledger boundary that
   phase 2 could only half-enforce.

   Everything here stays dark behind AFFILIATE_PROGRAM_ENABLED /
   AFFILIATE_QUALIFICATION_ENABLED. The LEGACY referral program is untouched:
   its code path is unchanged, its rows are unchanged, and it remains the only
   system that pays anything.

   Idempotent throughout, so the file can be run twice with the second run a
   no-op. */

/* ------------------------------------------------------------------ *
 * 1. THE CROSS-LEDGER BOUNDARY
 *
 * Phase 2 only checked one direction: when a shop was created, it looked for
 * an existing legacy claim. That could not stop the other order - a new
 * attribution committing first and the legacy row arriving afterwards, which
 * is exactly what happens today, because linkReferralOnShopCreate runs AFTER
 * the shop transaction commits.
 *
 * The fix is a trigger on the LEGACY table, so the invariant is enforced by
 * the database rather than by the order two application paths happen to run
 * in: inserting a legacy Referral atomically supersedes any live attribution
 * for the same referred shop, inside the legacy transaction. If that
 * transaction rolls back, so does the supersession. Legacy always wins, and
 * the legacy insert itself is never blocked or altered.
 * ------------------------------------------------------------------ */

ALTER TABLE "AffiliateReferralAttribution"
  ADD COLUMN IF NOT EXISTS "legacyReferralId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "AffiliateReferralAttribution_legacyReferralId_key"
  ON "AffiliateReferralAttribution"("legacyReferralId");

/* The audit vocabulary gains the supersession event. Additive: a CHECK swap,
   never an enum type change. */
ALTER TABLE "AffiliateAuditEvent"
  DROP CONSTRAINT IF EXISTS "AffiliateAuditEvent_type_check";
ALTER TABLE "AffiliateAuditEvent"
  ADD CONSTRAINT "AffiliateAuditEvent_type_check"
  CHECK ("type" IN (
    'application.submitted', 'application.approved', 'application.rejected',
    'account.suspended', 'account.reactivated',
    'attribution.locked', 'attribution.corrected',
    'attribution.superseded_by_legacy',
    'reward.qualified', 'reward.available', 'reward.reversed',
    'reward.expired', 'reward.review_flagged',
    'credit.applied', 'credit.adjusted'
  ));

/* SECURITY DEFINER so the transition works whatever role inserted the legacy
   row (the attribution table is default-deny, so chairback_app could not
   update it otherwise and the legacy INSERT would fail - which must never
   happen). search_path is pinned empty and every name fully qualified, the
   standard hardening for a definer function. */
CREATE OR REPLACE FUNCTION affiliate_legacy_supersedes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  superseded_id TEXT;
BEGIN
  /* Only a LIVE attribution is superseded. One already rejected is left
     exactly as it is, and the update is a no-op when there is nothing to
     supersede - the overwhelmingly common case, since this table is empty
     while the program is dark. */
  UPDATE public."AffiliateReferralAttribution"
     SET "state"            = 'REJECTED',
         "rejectionReason"  = 'legacy_claimed',
         "legacyReferralId" = NEW."id",
         "updatedAt"        = now()
   WHERE "referredShopId" = NEW."referredShopId"
     AND "state" = 'ATTRIBUTED'
  RETURNING "id" INTO superseded_id;

  IF superseded_id IS NOT NULL THEN
    /* Audited inside the SAME transaction as the legacy insert. Fixed codes
       only - no referral code, no free text, no personal data. */
    INSERT INTO public."AffiliateAuditEvent"
      ("id", "shopId", "type", "actorType", "metadata", "createdAt")
    VALUES (
      'aud' || replace(gen_random_uuid()::text, '-', ''),
      NEW."referredShopId",
      'attribution.superseded_by_legacy',
      'system',
      '{"toStatus":"REJECTED","rejectionReason":"legacy_claimed"}'::jsonb,
      now()
    );
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS affiliate_legacy_supersedes_ins ON "Referral";
CREATE TRIGGER affiliate_legacy_supersedes_ins
  AFTER INSERT ON "Referral"
  FOR EACH ROW EXECUTE FUNCTION affiliate_legacy_supersedes();

/* The supersession is the one state change the attribution lock permits
   besides an admin correction, so the immutability trigger has to know about
   it. Everything it guarded before is still guarded: the locked facts cannot
   move, and a reassignment still demands a recorded correction. */
CREATE OR REPLACE FUNCTION affiliate_attribution_locked() RETURNS trigger AS $fn$
BEGIN
  IF NEW."referredShopId" IS DISTINCT FROM OLD."referredShopId"
     OR NEW."codeUsed"       IS DISTINCT FROM OLD."codeUsed"
     OR NEW."source"         IS DISTINCT FROM OLD."source"
     OR NEW."capturedAt"     IS DISTINCT FROM OLD."capturedAt"
     OR NEW."lockedAt"       IS DISTINCT FROM OLD."lockedAt"
     OR NEW."claimExpiresAt" IS DISTINCT FROM OLD."claimExpiresAt" THEN
    RAISE EXCEPTION
      'AffiliateReferralAttribution: locked attribution facts are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  /* A reassignment needs either a recorded admin correction or a legacy
     supersession; nothing else may move the affiliate. */
  IF NEW."affiliateAccountId" IS DISTINCT FROM OLD."affiliateAccountId"
     AND NEW."correctedAt" IS NULL
     AND NEW."legacyReferralId" IS NULL THEN
    RAISE EXCEPTION
      'AffiliateReferralAttribution: reassignment requires a recorded correction'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

/* ------------------------------------------------------------------ *
 * 2. QUALIFICATION TABLES
 * ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS "StripeWebhookEvent" (
  "id"        TEXT NOT NULL,
  "eventId"   TEXT NOT NULL,
  "type"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StripeWebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StripeWebhookEvent_eventId_key"
  ON "StripeWebhookEvent"("eventId");
CREATE INDEX IF NOT EXISTS "StripeWebhookEvent_type_createdAt_idx"
  ON "StripeWebhookEvent"("type", "createdAt");

CREATE TABLE IF NOT EXISTS "AffiliateQualifyingInvoice" (
  "id"              TEXT NOT NULL,
  "referredShopId"  TEXT NOT NULL,
  "stripeInvoiceId" TEXT NOT NULL,
  "amountCents"     INTEGER NOT NULL,
  "currency"        TEXT NOT NULL,
  "paidAt"          TIMESTAMP(3) NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AffiliateQualifyingInvoice_pkey" PRIMARY KEY ("id")
);
/* 🔴 Distinct INVOICES, not deliveries: this is what makes a replayed or
   reordered webhook unable to inflate the count toward qualification. */
CREATE UNIQUE INDEX IF NOT EXISTS "AffiliateQualifyingInvoice_stripeInvoiceId_key"
  ON "AffiliateQualifyingInvoice"("stripeInvoiceId");
CREATE INDEX IF NOT EXISTS "AffiliateQualifyingInvoice_referredShopId_paidAt_idx"
  ON "AffiliateQualifyingInvoice"("referredShopId", "paidAt");

CREATE TABLE IF NOT EXISTS "AffiliateReward" (
  "id"                 TEXT NOT NULL,
  "affiliateAccountId" TEXT NOT NULL,
  "referredShopId"     TEXT NOT NULL,
  "attributionId"      TEXT NOT NULL,
  "rewardType"         TEXT NOT NULL,
  "amountCents"        INTEGER NOT NULL,
  "currency"           TEXT NOT NULL,
  "basisPlan"          TEXT NOT NULL,
  "status"             TEXT NOT NULL DEFAULT 'PENDING',
  "qualifiedAt"        TIMESTAMP(3) NOT NULL,
  "holdEndsAt"         TIMESTAMP(3) NOT NULL,
  "availableAt"        TIMESTAMP(3),
  "expiresAt"          TIMESTAMP(3),
  "reversedAt"         TIMESTAMP(3),
  "reversalReason"     TEXT,
  "reviewReason"       TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AffiliateReward_pkey" PRIMARY KEY ("id")
);
/* One qualification reward per referred shop, ever. */
CREATE UNIQUE INDEX IF NOT EXISTS "AffiliateReward_referredShopId_key"
  ON "AffiliateReward"("referredShopId");
CREATE UNIQUE INDEX IF NOT EXISTS "AffiliateReward_attributionId_key"
  ON "AffiliateReward"("attributionId");
CREATE INDEX IF NOT EXISTS "AffiliateReward_status_holdEndsAt_idx"
  ON "AffiliateReward"("status", "holdEndsAt");
CREATE INDEX IF NOT EXISTS "AffiliateReward_affiliateAccountId_status_idx"
  ON "AffiliateReward"("affiliateAccountId", "status");

ALTER TABLE "AffiliateReward" DROP CONSTRAINT IF EXISTS "AffiliateReward_status_check";
ALTER TABLE "AffiliateReward" ADD CONSTRAINT "AffiliateReward_status_check"
  CHECK ("status" IN ('PENDING','AVAILABLE','RESERVED','APPLIED','REVERSED','EXPIRED','REVIEW_REQUIRED'));
ALTER TABLE "AffiliateReward" DROP CONSTRAINT IF EXISTS "AffiliateReward_rewardType_check";
ALTER TABLE "AffiliateReward" ADD CONSTRAINT "AffiliateReward_rewardType_check"
  CHECK ("rewardType" IN ('subscription_credit'));
ALTER TABLE "AffiliateReward" DROP CONSTRAINT IF EXISTS "AffiliateReward_reversalReason_check";
ALTER TABLE "AffiliateReward" ADD CONSTRAINT "AffiliateReward_reversalReason_check"
  CHECK ("reversalReason" IS NULL OR "reversalReason" IN
    ('invoice_refunded','payment_disputed','credit_note','admin_adjustment'));
ALTER TABLE "AffiliateReward" DROP CONSTRAINT IF EXISTS "AffiliateReward_reviewReason_check";
ALTER TABLE "AffiliateReward" ADD CONSTRAINT "AffiliateReward_reviewReason_check"
  CHECK ("reviewReason" IS NULL OR "reviewReason" IN ('rolling_year_threshold'));
/* Money is never negative here, and a reversed reward says when. */
ALTER TABLE "AffiliateReward" DROP CONSTRAINT IF EXISTS "AffiliateReward_amount_check";
ALTER TABLE "AffiliateReward" ADD CONSTRAINT "AffiliateReward_amount_check"
  CHECK ("amountCents" > 0);
ALTER TABLE "AffiliateReward" DROP CONSTRAINT IF EXISTS "AffiliateReward_reversed_shape_check";
ALTER TABLE "AffiliateReward" ADD CONSTRAINT "AffiliateReward_reversed_shape_check"
  CHECK ("status" <> 'REVERSED' OR ("reversedAt" IS NOT NULL AND "reversalReason" IS NOT NULL));

/* 🔴 DEFAULT-DENY on all three, same reasoning as every other affiliate and
   platform table: revoke explicitly (ALTER DEFAULT PRIVILEGES already granted
   everything), then force RLS with no policies. */
REVOKE ALL ON "StripeWebhookEvent" FROM chairback_app;
ALTER TABLE "StripeWebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StripeWebhookEvent" FORCE ROW LEVEL SECURITY;

REVOKE ALL ON "AffiliateQualifyingInvoice" FROM chairback_app;
ALTER TABLE "AffiliateQualifyingInvoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AffiliateQualifyingInvoice" FORCE ROW LEVEL SECURITY;

REVOKE ALL ON "AffiliateReward" FROM chairback_app;
ALTER TABLE "AffiliateReward" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AffiliateReward" FORCE ROW LEVEL SECURITY;

/* The hold-release job. A scheduled job whose name has no job_lease row NEVER
   runs - withLease acquires by UPDATE only. */
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt")
VALUES ('affiliate-reward-hold', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
