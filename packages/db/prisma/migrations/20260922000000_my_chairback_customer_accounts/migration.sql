/* MY CHAIRBACK - the customer's own account, and its links to shop records.

   ADDITIVE ONLY. Five new tables, one new index on "Client", and one unique
   constraint on ("Client"."id", "Client"."shopId") that exists purely to be
   the target of a composite foreign key. No existing column is altered, no
   existing row is written, and nothing is backfilled: an account is created
   only when its owner proves a phone or an email with a one-time code, and
   links are computed from that proof at read time.

   All five tables are PLATFORM data (no shopId owns an account), so they take
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
  /* Why a link is not active, for operators and tests. Internal words only -
     never rendered, never returned to a customer. */
  "statusReason" TEXT,
  /* 🔴 THE CREDENTIAL A CLAIMED PROFILE WAS PROVEN WITH: an HMAC of that
     client's rewards link (Client.magicToken) as it stood when the customer
     claimed it. A verified phone or email is NOT proof that a record is
     yours where more than one person shares that contact - a parent and a
     child on one number is the everyday case - so an ambiguous record is
     connected by ALSO holding the shop's own link to it. The digest is
     stored, never the token, and rotating that link revokes the claim on the
     next read. */
  "claimDigest" TEXT,
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
  CHECK ("matchedBy" IN ('phone', 'email', 'claim'));
ALTER TABLE "CustomerClientLink"
  ADD CONSTRAINT "CustomerClientLink_status_check"
  CHECK ("status" IN ('active', 'rejected', 'detached'));
/* A claimed link is exactly the one that carries a credential digest. */
ALTER TABLE "CustomerClientLink"
  ADD CONSTRAINT "CustomerClientLink_claim_digest_check"
  CHECK (("matchedBy" = 'claim') = ("claimDigest" IS NOT NULL));

ALTER TABLE "CustomerClientLink"
  ADD CONSTRAINT "CustomerClientLink_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerClientLink"
  ADD CONSTRAINT "CustomerClientLink_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerClientLink"
  ADD CONSTRAINT "CustomerClientLink_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/* 🔴 A LINK MAY NOT PAIR ONE SHOP WITH ANOTHER SHOP'S CLIENT.
   `shopId` decides which tenant transaction the portal reads this record in,
   and the single-column foreign key above only checks that the client exists
   SOMEWHERE. A row stamped with shop A and shop B's client would read B's
   rows inside A's session. The composite key makes such a row unstorable.

   The referenced pair must be unique for a composite foreign key to point at
   it; `id` is already the primary key, so this adds no restriction on Client.
   Created only if absent: PR #413 adds the same constraint under the same name
   for BroadcastSend, and whichever migration runs first must not make the
   other fail. */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Client_id_shopId_key' AND conrelid = '"Client"'::regclass
  ) THEN
    ALTER TABLE "Client" ADD CONSTRAINT "Client_id_shopId_key" UNIQUE ("id", "shopId");
  END IF;
END $$;

ALTER TABLE "CustomerClientLink"
  ADD CONSTRAINT "CustomerClientLink_client_same_shop_fkey"
  FOREIGN KEY ("clientId", "shopId") REFERENCES "Client"("id", "shopId")
  ON DELETE CASCADE ON UPDATE CASCADE;

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

-- One-time sign-in code DELIVERY ------------------------------------------------

/* 🔴 THE CHALLENGE AND THE PROMISE TO DELIVER IT ARE COMMITTED TOGETHER.
   The first cut sent inside `void (async () => ...)`: the code and its
   cooldown were durable, the send was not, so a deploy or a crash in the
   following milliseconds left a customer holding a valid challenge that was
   never posted to anybody - and a 60-second cooldown telling them to wait
   before trying again. This row is the promise, drained by a lease-guarded
   worker, exactly as EmailIntent and BroadcastSend are.

   `sealed` is the ONLY place the code and the destination exist at rest, and
   it is AES-256-GCM under a key derived from TOKEN_ENCRYPTION_KEY for this
   purpose alone. It is wiped the moment the row reaches a terminal state, so
   a delivered or abandoned challenge leaves neither behind. The identifier
   itself is still only ever an HMAC on "CustomerSignInCode". */
CREATE TABLE "CustomerSignInDelivery" (
  "id"                     TEXT NOT NULL,
  "codeId"                 TEXT NOT NULL,
  "channel"                TEXT NOT NULL,
  /* iv:tag:ciphertext of {"to","code"}. NULL once terminal. */
  "sealed"                 TEXT,
  "status"                 TEXT NOT NULL DEFAULT 'pending',
  /* Real provider dispatches only - a claim is not an attempt. */
  "attempts"               INTEGER NOT NULL DEFAULT 0,
  "firstProviderAttemptAt" TIMESTAMP(3),
  /* Write-ahead: committed BEFORE the request leaves, so a process that dies
     after the provider accepted still leaves a row that says so. */
  "lastAttemptAmbiguous"   BOOLEAN NOT NULL DEFAULT false,
  "nextAttemptAt"          TIMESTAMP(3),
  "claimedAt"              TIMESTAMP(3),
  "claimToken"             TEXT,
  /* Fixed classification only - never a provider message, never a contact. */
  "lastError"              TEXT,
  "providerMessageId"      TEXT,
  /* Stable per delivery, so a retried EMAIL is collapsed by Resend itself. */
  "idempotencyKey"         TEXT NOT NULL,
  "expiresAt"              TIMESTAMP(3) NOT NULL,
  "sentAt"                 TIMESTAMP(3),
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CustomerSignInDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerSignInDelivery_idempotencyKey_key"
  ON "CustomerSignInDelivery"("idempotencyKey");
/* The claim scan: due, unclaimed or stale, oldest first. */
CREATE INDEX "CustomerSignInDelivery_status_nextAttemptAt_idx"
  ON "CustomerSignInDelivery"("status", "nextAttemptAt");
CREATE INDEX "CustomerSignInDelivery_codeId_idx" ON "CustomerSignInDelivery"("codeId");

ALTER TABLE "CustomerSignInDelivery"
  ADD CONSTRAINT "CustomerSignInDelivery_channel_check"
  CHECK ("channel" IN ('sms', 'email'));
ALTER TABLE "CustomerSignInDelivery"
  ADD CONSTRAINT "CustomerSignInDelivery_status_check"
  CHECK ("status" IN ('pending', 'sent', 'failed', 'abandoned', 'superseded', 'expired', 'suppressed'));
/* Nothing terminal may still be holding a code. */
ALTER TABLE "CustomerSignInDelivery"
  ADD CONSTRAINT "CustomerSignInDelivery_sealed_only_while_pending_check"
  CHECK ("status" = 'pending' OR "sealed" IS NULL);

ALTER TABLE "CustomerSignInDelivery"
  ADD CONSTRAINT "CustomerSignInDelivery_codeId_fkey"
  FOREIGN KEY ("codeId") REFERENCES "CustomerSignInCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Email matching ---------------------------------------------------------------

/* Client.email is stored as typed; the linking engine matches on
   lower(btrim("email")) = <proven, normalized email>. Without this the match
   is a sequential scan over every shop's clients.

   🔴 btrim IS PART OF THE KEY, not a nicety. The engine has to decide whether
   a contact is shared by more than one record at a shop, and " a@b.com " and
   "a@b.com" are the same address to every mail server on earth. Matching on
   lower() alone would count them as different people, call the contact
   unambiguous, and link one of the two records automatically.

   A plain equality index, not a pattern match: an ILIKE would treat "_" and
   "%" in an address as wildcards. */
CREATE INDEX "Client_email_norm_idx" ON "Client" (lower(btrim("email")));

-- The delivery worker's lease --------------------------------------------------

/* 🔴 withLease() ACQUIRES BY UPDATE ONLY: a job whose name was never seeded
   matches zero rows and silently never runs in any deployed environment,
   while its own unit test stays green. scheduler.leaseSeed.test.ts fails
   without this line. */
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt") VALUES
    ('customer-signin-outbox', '', now(), now())
ON CONFLICT ("name") DO NOTHING;

-- Default-deny ------------------------------------------------------------------

/* Revoke explicitly first: under this database's ALTER DEFAULT PRIVILEGES a
   newly created table may carry grants, and "no grant was issued" is not the
   same as "no privilege is held". Zero policies + FORCE = the tenant role sees
   nothing and writes nothing. */
REVOKE ALL ON "CustomerAccount" FROM chairback_app;
REVOKE ALL ON "CustomerClientLink" FROM chairback_app;
REVOKE ALL ON "CustomerDevice" FROM chairback_app;
REVOKE ALL ON "CustomerSignInCode" FROM chairback_app;
REVOKE ALL ON "CustomerSignInDelivery" FROM chairback_app;

ALTER TABLE "CustomerAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerAccount" FORCE ROW LEVEL SECURITY;
ALTER TABLE "CustomerClientLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerClientLink" FORCE ROW LEVEL SECURITY;
ALTER TABLE "CustomerDevice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerDevice" FORCE ROW LEVEL SECURITY;
ALTER TABLE "CustomerSignInCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerSignInCode" FORCE ROW LEVEL SECURITY;
ALTER TABLE "CustomerSignInDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerSignInDelivery" FORCE ROW LEVEL SECURITY;
