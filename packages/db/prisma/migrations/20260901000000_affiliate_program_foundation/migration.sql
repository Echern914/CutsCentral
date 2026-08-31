/* AFFILIATE PROGRAM v1 - PR 1 of the arc: applications, accounts, and the
   append-only audit spine. The legacy referral program (the "Referral" table,
   Shop.referralCode, User.referralCode) is untouched and keeps running; it is
   frozen in the attribution phase, not here.

   All three tables are DEFAULT-DENY at the DB layer (the PhoneRecoveryCode /
   EmailDelivery pattern): REVOKE from chairback_app, RLS enabled + FORCED,
   ZERO policies. Applications and accounts carry admin-internal fields
   (internalNote, decidedByUserId) and RLS is row-level, not column-level, so
   a tenant policy would hand those to every tenant-scoped code path - the MCP
   assistant surface included. Owner-facing reads instead go through ONE masked
   owner-executed service keyed by the SESSION's shop id, and the audit table
   is platform history that will reference cross-shop facts from the
   attribution phase onward.

   Idempotent on purpose (IF NOT EXISTS / DROP ... IF EXISTS / OR REPLACE):
   the migration must be runnable twice with the second run a no-op. */

CREATE TABLE IF NOT EXISTS "AffiliateApplication" (
  "id"                   TEXT NOT NULL,
  "shopId"               TEXT NOT NULL,
  "submittedByUserId"    TEXT NOT NULL,
  "status"               TEXT NOT NULL DEFAULT 'PENDING',

  /* What the applicant told us. Free text is length-capped at the API; the
     channel list is validated against the config vocabulary there too. */
  "promotionChannels"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "audienceDescription"  TEXT NOT NULL,
  "links"                TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "promotionPlan"        TEXT NOT NULL,
  /* FTC disclosure acknowledgement - a required checkbox, recorded as the
     instant it was ticked (the sms-consent shape: never a bare boolean). */
  "ftcAcknowledgedAt"    TIMESTAMP(3) NOT NULL,

  /* Terms acceptance, versioned. */
  "acceptedTermsVersion" TEXT NOT NULL,
  "acceptedTermsAt"      TIMESTAMP(3) NOT NULL,
  "acceptedTermsSource"  TEXT NOT NULL DEFAULT 'dashboard',

  /* The decision. decisionReason is a FIXED classification; the applicant-
     visible message is derived from it in config - admin free text
     (internalNote) never reaches the applicant. */
  "decidedAt"            TIMESTAMP(3),
  "decidedByUserId"      TEXT,
  "decisionReason"       TEXT,
  "internalNote"         TEXT,

  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AffiliateApplication_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AffiliateAccount" (
  "id"                   TEXT NOT NULL,
  "shopId"               TEXT NOT NULL,
  "applicationId"        TEXT NOT NULL,
  /* The public referral code. An identifier, not a credential - it is printed
     into share links - so plaintext, but random enough (72 bits) that
     enumeration finds nothing. */
  "code"                 TEXT NOT NULL,
  "status"               TEXT NOT NULL DEFAULT 'ACTIVE',

  "suspendedAt"          TIMESTAMP(3),
  "suspensionReason"     TEXT,
  "reactivatedAt"        TIMESTAMP(3),
  "internalNote"         TEXT,

  /* Snapshots of what this affiliate agreed to / was approved under. */
  "acceptedTermsVersion" TEXT NOT NULL,
  "policyVersion"        INTEGER NOT NULL,

  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AffiliateAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AffiliateAuditEvent" (
  "id"            TEXT NOT NULL,
  "shopId"        TEXT NOT NULL,
  "applicationId" TEXT,
  "accountId"     TEXT,
  "type"          TEXT NOT NULL,
  "actorType"     TEXT NOT NULL,
  "actorUserId"   TEXT,
  "metadata"      JSONB,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AffiliateAuditEvent_pkey" PRIMARY KEY ("id")
);

/* ---- indexes ---- */

CREATE INDEX IF NOT EXISTS "AffiliateApplication_status_createdAt_idx"
  ON "AffiliateApplication"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "AffiliateApplication_shopId_idx"
  ON "AffiliateApplication"("shopId");

/* 🔴 THE DOUBLE-SUBMIT GUARD. At most one OPEN application per shop, enforced
   by Postgres against concurrent requests. The service catches the unique
   violation and answers 409 - it never pre-checks-then-inserts, because two
   racing pre-checks both pass. Prisma cannot express a partial unique index;
   this SQL is the source of truth, same as every CHECK and trigger here. */
CREATE UNIQUE INDEX IF NOT EXISTS "AffiliateApplication_one_pending_per_shop"
  ON "AffiliateApplication"("shopId") WHERE "status" = 'PENDING';

CREATE UNIQUE INDEX IF NOT EXISTS "AffiliateAccount_shopId_key"
  ON "AffiliateAccount"("shopId");
CREATE UNIQUE INDEX IF NOT EXISTS "AffiliateAccount_applicationId_key"
  ON "AffiliateAccount"("applicationId");
CREATE UNIQUE INDEX IF NOT EXISTS "AffiliateAccount_code_key"
  ON "AffiliateAccount"("code");
CREATE INDEX IF NOT EXISTS "AffiliateAccount_status_idx"
  ON "AffiliateAccount"("status");

CREATE INDEX IF NOT EXISTS "AffiliateAuditEvent_shopId_createdAt_idx"
  ON "AffiliateAuditEvent"("shopId", "createdAt");
CREATE INDEX IF NOT EXISTS "AffiliateAuditEvent_accountId_createdAt_idx"
  ON "AffiliateAuditEvent"("accountId", "createdAt");
CREATE INDEX IF NOT EXISTS "AffiliateAuditEvent_type_createdAt_idx"
  ON "AffiliateAuditEvent"("type", "createdAt");

/* ---- vocabularies, pinned by CHECK (a CHECK is additive; an enum change
        rewrites the column type) ---- */

ALTER TABLE "AffiliateApplication"
  DROP CONSTRAINT IF EXISTS "AffiliateApplication_status_check";
ALTER TABLE "AffiliateApplication"
  ADD CONSTRAINT "AffiliateApplication_status_check"
  CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED'));

ALTER TABLE "AffiliateApplication"
  DROP CONSTRAINT IF EXISTS "AffiliateApplication_decisionReason_check";
ALTER TABLE "AffiliateApplication"
  ADD CONSTRAINT "AffiliateApplication_decisionReason_check"
  CHECK ("decisionReason" IS NULL OR "decisionReason" IN
    ('approved', 'incomplete_application', 'not_eligible', 'duplicate',
     'policy_violation', 'other'));

/* A decided application says who and when; a pending one says neither. */
ALTER TABLE "AffiliateApplication"
  DROP CONSTRAINT IF EXISTS "AffiliateApplication_decision_shape_check";
ALTER TABLE "AffiliateApplication"
  ADD CONSTRAINT "AffiliateApplication_decision_shape_check"
  CHECK (("status" = 'PENDING') = ("decidedAt" IS NULL));

ALTER TABLE "AffiliateAccount"
  DROP CONSTRAINT IF EXISTS "AffiliateAccount_status_check";
ALTER TABLE "AffiliateAccount"
  ADD CONSTRAINT "AffiliateAccount_status_check"
  CHECK ("status" IN ('ACTIVE', 'SUSPENDED'));

ALTER TABLE "AffiliateAccount"
  DROP CONSTRAINT IF EXISTS "AffiliateAccount_suspensionReason_check";
ALTER TABLE "AffiliateAccount"
  ADD CONSTRAINT "AffiliateAccount_suspensionReason_check"
  CHECK ("suspensionReason" IS NULL OR "suspensionReason" IN
    ('terms_violation', 'suspected_abuse', 'admin_review', 'other'));

/* A SUSPENDED account must say when and why. (An ACTIVE account may keep its
   old suspendedAt/reason as history of a past suspension.) */
ALTER TABLE "AffiliateAccount"
  DROP CONSTRAINT IF EXISTS "AffiliateAccount_suspended_shape_check";
ALTER TABLE "AffiliateAccount"
  ADD CONSTRAINT "AffiliateAccount_suspended_shape_check"
  CHECK ("status" <> 'SUSPENDED'
         OR ("suspendedAt" IS NOT NULL AND "suspensionReason" IS NOT NULL));

/* The audit vocabulary pins the FULL ARC now (the waitlist lesson: later
   phases must never alter a constraint under live traffic). PR 1 writes only
   the application.* / account.* types; the rest are reserved for the
   attribution, qualification and credit phases. */
ALTER TABLE "AffiliateAuditEvent"
  DROP CONSTRAINT IF EXISTS "AffiliateAuditEvent_type_check";
ALTER TABLE "AffiliateAuditEvent"
  ADD CONSTRAINT "AffiliateAuditEvent_type_check"
  CHECK ("type" IN (
    'application.submitted', 'application.approved', 'application.rejected',
    'account.suspended', 'account.reactivated',
    'attribution.locked', 'attribution.corrected',
    'reward.qualified', 'reward.available', 'reward.reversed',
    'reward.expired', 'reward.review_flagged',
    'credit.applied', 'credit.adjusted'
  ));

ALTER TABLE "AffiliateAuditEvent"
  DROP CONSTRAINT IF EXISTS "AffiliateAuditEvent_actorType_check";
ALTER TABLE "AffiliateAuditEvent"
  ADD CONSTRAINT "AffiliateAuditEvent_actorType_check"
  CHECK ("actorType" IN ('admin', 'applicant', 'system'));

/* An unattributed admin action would READ as attributed while being worth
   nothing - the database refuses it outright. */
ALTER TABLE "AffiliateAuditEvent"
  DROP CONSTRAINT IF EXISTS "AffiliateAuditEvent_admin_actor_check";
ALTER TABLE "AffiliateAuditEvent"
  ADD CONSTRAINT "AffiliateAuditEvent_admin_actor_check"
  CHECK ("actorType" <> 'admin' OR "actorUserId" IS NOT NULL);

/* ---- foreign keys ----
   Applications and accounts die with their shop (data-deletion hygiene).
   The AUDIT table has NO foreign keys on purpose: money-adjacent history must
   outlive the shop it describes, and it carries ids and fixed codes only -
   never personal data - so retaining it is defensible. */

ALTER TABLE "AffiliateApplication"
  DROP CONSTRAINT IF EXISTS "AffiliateApplication_shopId_fkey";
ALTER TABLE "AffiliateApplication"
  ADD CONSTRAINT "AffiliateApplication_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AffiliateAccount"
  DROP CONSTRAINT IF EXISTS "AffiliateAccount_shopId_fkey";
ALTER TABLE "AffiliateAccount"
  ADD CONSTRAINT "AffiliateAccount_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

/* ---- append-only ----
   The BEFORE UPDATE trigger binds every role INCLUDING the connection owner
   (grants alone constrain almost nothing here - most code paths run as the
   owner with no role switch). Deliberately NOT a DELETE trigger: a row-level
   DELETE trigger would also fire for the shopId cascade if one existed, and
   deletion stays governed by retention; MUTATION is the forgery vector. */

CREATE OR REPLACE FUNCTION affiliate_audit_event_immutable() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'AffiliateAuditEvent is append-only: UPDATE is not permitted'
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS affiliate_audit_event_no_update ON "AffiliateAuditEvent";
CREATE TRIGGER affiliate_audit_event_no_update
  BEFORE UPDATE ON "AffiliateAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION affiliate_audit_event_immutable();

/* ---- 🔴 DEFAULT-DENY, all three tables ----
   Revoke explicitly FIRST: under this database's ALTER DEFAULT PRIVILEGES a
   newly created table already carries all four grants for chairback_app, so
   "no grant was issued" is not the same as "no privilege is held". Zero
   policies + FORCE means the app role reads nothing and writes nothing; every
   access is an owner-executed service behind the session/admin gates. */

REVOKE ALL ON "AffiliateApplication" FROM chairback_app;
ALTER TABLE "AffiliateApplication" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AffiliateApplication" FORCE ROW LEVEL SECURITY;

REVOKE ALL ON "AffiliateAccount" FROM chairback_app;
ALTER TABLE "AffiliateAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AffiliateAccount" FORCE ROW LEVEL SECURITY;

REVOKE ALL ON "AffiliateAuditEvent" FROM chairback_app;
ALTER TABLE "AffiliateAuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AffiliateAuditEvent" FORCE ROW LEVEL SECURITY;
