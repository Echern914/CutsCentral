/* AFFILIATE ATTRIBUTION (arc phase 2): the durable claim outcome per referred
   shop, plus bounded daily click counters.

   The LEGACY referral program is untouched by this migration and remains
   authoritative in production. Nothing here is ever written while
   AFFILIATE_PROGRAM_ENABLED is false, so no shop can be claimed by both
   systems: the new tables simply stay empty until a later, separately
   reviewed cutover.

   Default-deny, same as the phase-1 tables: REVOKE from chairback_app, RLS
   enabled + FORCED, ZERO policies. Attribution spans TWO shops (the referrer
   and the referred), which is exactly the shape no tenant session may read.

   Idempotent (IF NOT EXISTS / DROP ... IF EXISTS / OR REPLACE) so the file can
   be run twice with the second run a no-op. */

CREATE TABLE IF NOT EXISTS "AffiliateReferralAttribution" (
  "id"                         TEXT NOT NULL,
  "affiliateAccountId"         TEXT,
  "referredShopId"             TEXT NOT NULL,
  "codeUsed"                   TEXT NOT NULL,
  "source"                     TEXT NOT NULL,
  "state"                      TEXT NOT NULL,
  "rejectionReason"            TEXT,
  "capturedAt"                 TIMESTAMP(3) NOT NULL,
  "lockedAt"                   TIMESTAMP(3) NOT NULL,
  "claimExpiresAt"             TIMESTAMP(3) NOT NULL,
  "correctedAt"                TIMESTAMP(3),
  "correctedByUserId"          TEXT,
  "correctionReason"           TEXT,
  "previousAffiliateAccountId" TEXT,
  "createdAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AffiliateReferralAttribution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AffiliateClickDay" (
  "id"                 TEXT NOT NULL,
  "affiliateAccountId" TEXT NOT NULL,
  "day"                DATE NOT NULL,
  "count"              INTEGER NOT NULL DEFAULT 0,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AffiliateClickDay_pkey" PRIMARY KEY ("id")
);

/* 🔴 ONE ATTRIBUTION PER REFERRED SHOP, enforced by the database rather than
   by an application check that two concurrent shop creations would both pass.
   The insert is a skipDuplicates createMany, so the loser of that race is a
   no-op instead of an exception that would abort the shop transaction. */
CREATE UNIQUE INDEX IF NOT EXISTS "AffiliateReferralAttribution_referredShopId_key"
  ON "AffiliateReferralAttribution"("referredShopId");
CREATE INDEX IF NOT EXISTS "AffiliateReferralAttribution_affiliateAccountId_state_idx"
  ON "AffiliateReferralAttribution"("affiliateAccountId", "state");
CREATE INDEX IF NOT EXISTS "AffiliateReferralAttribution_state_lockedAt_idx"
  ON "AffiliateReferralAttribution"("state", "lockedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "AffiliateClickDay_affiliateAccountId_day_key"
  ON "AffiliateClickDay"("affiliateAccountId", "day");
CREATE INDEX IF NOT EXISTS "AffiliateClickDay_day_idx" ON "AffiliateClickDay"("day");

/* Vocabularies pinned by CHECK (additive, unlike an enum type change). */
ALTER TABLE "AffiliateReferralAttribution"
  DROP CONSTRAINT IF EXISTS "AffiliateReferralAttribution_state_check";
ALTER TABLE "AffiliateReferralAttribution"
  ADD CONSTRAINT "AffiliateReferralAttribution_state_check"
  CHECK ("state" IN ('ATTRIBUTED', 'REJECTED'));

ALTER TABLE "AffiliateReferralAttribution"
  DROP CONSTRAINT IF EXISTS "AffiliateReferralAttribution_source_check";
ALTER TABLE "AffiliateReferralAttribution"
  ADD CONSTRAINT "AffiliateReferralAttribution_source_check"
  CHECK ("source" IN ('link', 'explicit_code'));

ALTER TABLE "AffiliateReferralAttribution"
  DROP CONSTRAINT IF EXISTS "AffiliateReferralAttribution_rejectionReason_check";
ALTER TABLE "AffiliateReferralAttribution"
  ADD CONSTRAINT "AffiliateReferralAttribution_rejectionReason_check"
  CHECK ("rejectionReason" IS NULL OR "rejectionReason" IN
    ('unknown_code', 'affiliate_suspended', 'self_referral', 'claim_expired',
     'legacy_claimed'));

/* An ATTRIBUTED row names an account and no reason; a REJECTED row names a
   reason. Neither shape can be written by mistake. */
ALTER TABLE "AffiliateReferralAttribution"
  DROP CONSTRAINT IF EXISTS "AffiliateReferralAttribution_state_shape_check";
ALTER TABLE "AffiliateReferralAttribution"
  ADD CONSTRAINT "AffiliateReferralAttribution_state_shape_check"
  CHECK (
    ("state" = 'ATTRIBUTED' AND "affiliateAccountId" IS NOT NULL AND "rejectionReason" IS NULL)
    OR
    ("state" = 'REJECTED' AND "rejectionReason" IS NOT NULL)
  );

/* A correction must say who and why, or not have happened at all. */
ALTER TABLE "AffiliateReferralAttribution"
  DROP CONSTRAINT IF EXISTS "AffiliateReferralAttribution_correction_shape_check";
ALTER TABLE "AffiliateReferralAttribution"
  ADD CONSTRAINT "AffiliateReferralAttribution_correction_shape_check"
  CHECK (
    ("correctedAt" IS NULL AND "correctedByUserId" IS NULL AND "correctionReason" IS NULL)
    OR
    ("correctedAt" IS NOT NULL AND "correctedByUserId" IS NOT NULL AND "correctionReason" IS NOT NULL)
  );

ALTER TABLE "AffiliateClickDay"
  DROP CONSTRAINT IF EXISTS "AffiliateClickDay_count_check";
ALTER TABLE "AffiliateClickDay"
  ADD CONSTRAINT "AffiliateClickDay_count_check" CHECK ("count" >= 0);

/* 🔴 THE LOCK IS THE LOCK. Attribution is decided once, when the shop is
   created; after that the facts of the claim are immutable at the database
   layer, for every role including the connection owner. The ONLY legal
   mutation is a platform-admin correction, which may move affiliateAccountId
   and must fill the correction columns - the seven-day window and the audit
   event are enforced by the service above it.

   A BEFORE UPDATE trigger rather than grants, for the same reason as the audit
   table: most code paths run as the owner with no role switch, so a grant
   withheld from chairback_app would constrain almost nothing. */
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
  IF NEW."affiliateAccountId" IS DISTINCT FROM OLD."affiliateAccountId"
     AND NEW."correctedAt" IS NULL THEN
    RAISE EXCEPTION
      'AffiliateReferralAttribution: reassignment requires a recorded correction'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS affiliate_attribution_locked_upd ON "AffiliateReferralAttribution";
CREATE TRIGGER affiliate_attribution_locked_upd
  BEFORE UPDATE ON "AffiliateReferralAttribution"
  FOR EACH ROW EXECUTE FUNCTION affiliate_attribution_locked();

/* 🔴 DEFAULT-DENY. Revoke first: ALTER DEFAULT PRIVILEGES already handed
   chairback_app all four verbs on these brand-new tables, so "no grant was
   issued" is not "no privilege is held". Zero policies + FORCE means the app
   role reads nothing and writes nothing here. */
REVOKE ALL ON "AffiliateReferralAttribution" FROM chairback_app;
ALTER TABLE "AffiliateReferralAttribution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AffiliateReferralAttribution" FORCE ROW LEVEL SECURITY;

REVOKE ALL ON "AffiliateClickDay" FROM chairback_app;
ALTER TABLE "AffiliateClickDay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AffiliateClickDay" FORCE ROW LEVEL SECURITY;
