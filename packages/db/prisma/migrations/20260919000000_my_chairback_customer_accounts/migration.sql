/* MY CHAIRBACK - the customer's own account, and its links to shop records.

   ADDITIVE ONLY. Four new tables and one new index on "Client". No existing
   column is altered, no existing row is written, and nothing is backfilled:
   an account is created only when its owner proves a phone or an email with a
   one-time code, and links are computed from that proof at read time. Rolling
   back is dropping the four tables and the index.

   All four tables are PLATFORM data (no shopId owns an account), so they take
   the PhoneRecoveryCode posture: RLS enabled + FORCED with NO policy and NO
   grants to chairback_app. Every access goes through the owner-executed
   services; the tenant role can neither read nor write a single row. */

-- The account -----------------------------------------------------------------

CREATE TABLE "CustomerAccount" (
  "id"              TEXT NOT NULL,
  "firstName"       TEXT,
  "lastName"        TEXT,
  "phoneE164"       TEXT,
  "phoneVerifiedAt" TIMESTAMP(3),
  "emailNormalized" TEXT,
  "emailVerifiedAt" TIMESTAMP(3),
  "tokenVersion"    INTEGER NOT NULL DEFAULT 0,
  "pushEnabled"     BOOLEAN NOT NULL DEFAULT true,
  "isDemo"          BOOLEAN NOT NULL DEFAULT false,
  "lastSeenAt"      TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CustomerAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerAccount_phoneE164_key" ON "CustomerAccount"("phoneE164");
CREATE UNIQUE INDEX "CustomerAccount_emailNormalized_key" ON "CustomerAccount"("emailNormalized");

/* A contact is only ever stored in its normalized form, and only once proven:
   the verified-at stamp and the value arrive together or not at all. */
ALTER TABLE "CustomerAccount"
  ADD CONSTRAINT "CustomerAccount_phone_proven_check"
  CHECK (("phoneE164" IS NULL) = ("phoneVerifiedAt" IS NULL));
ALTER TABLE "CustomerAccount"
  ADD CONSTRAINT "CustomerAccount_email_proven_check"
  CHECK (("emailNormalized" IS NULL) = ("emailVerifiedAt" IS NULL));
ALTER TABLE "CustomerAccount"
  ADD CONSTRAINT "CustomerAccount_email_normalized_check"
  CHECK ("emailNormalized" IS NULL OR "emailNormalized" = lower(btrim("emailNormalized")));

-- Account <-> shop record links ---------------------------------------------

CREATE TABLE "CustomerClientLink" (
  "id"        TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "clientId"  TEXT NOT NULL,
  "shopId"    TEXT NOT NULL,
  "matchedBy" TEXT NOT NULL,
  "status"    TEXT NOT NULL DEFAULT 'active',
  "linkedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "statusAt"  TIMESTAMP(3),

  CONSTRAINT "CustomerClientLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerClientLink_accountId_clientId_key" ON "CustomerClientLink"("accountId", "clientId");
CREATE INDEX "CustomerClientLink_accountId_status_idx" ON "CustomerClientLink"("accountId", "status");
CREATE INDEX "CustomerClientLink_clientId_idx" ON "CustomerClientLink"("clientId");
CREATE INDEX "CustomerClientLink_shopId_idx" ON "CustomerClientLink"("shopId");

/* 🔴 A shop record is ACTIVELY linked to at most one account. Partial on
   purpose: a rejection or a detachment is per-account memory and must not
   block the record's real owner from linking it. */
CREATE UNIQUE INDEX "CustomerClientLink_clientId_active_key"
  ON "CustomerClientLink"("clientId") WHERE "status" = 'active';

ALTER TABLE "CustomerClientLink"
  ADD CONSTRAINT "CustomerClientLink_matchedBy_check"
  CHECK ("matchedBy" IN ('phone', 'email'));
ALTER TABLE "CustomerClientLink"
  ADD CONSTRAINT "CustomerClientLink_status_check"
  CHECK ("status" IN ('active', 'rejected', 'detached'));

ALTER TABLE "CustomerClientLink"
  ADD CONSTRAINT "CustomerClientLink_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerClientLink"
  ADD CONSTRAINT "CustomerClientLink_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerClientLink"
  ADD CONSTRAINT "CustomerClientLink_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Devices signed in to My ChairBack ------------------------------------------

CREATE TABLE "CustomerDevice" (
  "id"            TEXT NOT NULL,
  "accountId"     TEXT NOT NULL,
  "expoPushToken" TEXT NOT NULL,
  "platform"      TEXT NOT NULL,
  "failureCount"  INTEGER NOT NULL DEFAULT 0,
  "lastSeenAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CustomerDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerDevice_expoPushToken_key" ON "CustomerDevice"("expoPushToken");
CREATE INDEX "CustomerDevice_accountId_idx" ON "CustomerDevice"("accountId");

ALTER TABLE "CustomerDevice"
  ADD CONSTRAINT "CustomerDevice_platform_check"
  CHECK ("platform" IN ('ios', 'android'));

ALTER TABLE "CustomerDevice"
  ADD CONSTRAINT "CustomerDevice_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One-time sign-in codes -------------------------------------------------------

CREATE TABLE "CustomerSignInCode" (
  "id"             TEXT NOT NULL,
  "channel"        TEXT NOT NULL,
  "identifierHash" TEXT NOT NULL,
  "ipHash"         TEXT NOT NULL,
  "codeHash"       TEXT NOT NULL,
  "attemptCount"   INTEGER NOT NULL DEFAULT 0,
  "expiresAt"      TIMESTAMP(3) NOT NULL,
  "consumedAt"     TIMESTAMP(3),
  "lastSentAt"     TIMESTAMP(3) NOT NULL,
  "sendCount"      INTEGER NOT NULL DEFAULT 1,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CustomerSignInCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerSignInCode_channel_identifierHash_key" ON "CustomerSignInCode"("channel", "identifierHash");
CREATE INDEX "CustomerSignInCode_expiresAt_idx" ON "CustomerSignInCode"("expiresAt");
CREATE INDEX "CustomerSignInCode_ipHash_lastSentAt_idx" ON "CustomerSignInCode"("ipHash", "lastSentAt");

ALTER TABLE "CustomerSignInCode"
  ADD CONSTRAINT "CustomerSignInCode_channel_check"
  CHECK ("channel" IN ('sms', 'email'));

-- Email matching ---------------------------------------------------------------

/* Client.email is stored as typed; the linking engine matches on
   lower("email") = <proven, normalized email>. Without this the match is a
   sequential scan over every shop's clients. A plain equality index, not a
   pattern match: an ILIKE would treat "_" and "%" in an address as wildcards. */
CREATE INDEX "Client_email_lower_idx" ON "Client" (lower("email"));

-- Default-deny ------------------------------------------------------------------

/* Revoke explicitly first: under this database's ALTER DEFAULT PRIVILEGES a
   newly created table may carry grants, and "no grant was issued" is not the
   same as "no privilege is held". Zero policies + FORCE = the tenant role sees
   nothing and writes nothing. */
REVOKE ALL ON "CustomerAccount" FROM chairback_app;
REVOKE ALL ON "CustomerClientLink" FROM chairback_app;
REVOKE ALL ON "CustomerDevice" FROM chairback_app;
REVOKE ALL ON "CustomerSignInCode" FROM chairback_app;

ALTER TABLE "CustomerAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerAccount" FORCE ROW LEVEL SECURITY;
ALTER TABLE "CustomerClientLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerClientLink" FORCE ROW LEVEL SECURITY;
ALTER TABLE "CustomerDevice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerDevice" FORCE ROW LEVEL SECURITY;
ALTER TABLE "CustomerSignInCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerSignInCode" FORCE ROW LEVEL SECURITY;
