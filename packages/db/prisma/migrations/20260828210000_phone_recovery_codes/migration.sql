/* Platform-scoped phone-recovery challenges (rewards recovery).

   No tenant exists before verification - "which shops know this phone" is the
   question the flow answers - so this table CANNOT be tenant-isolated, and we
   do not pretend it is. Same intentional default-deny as the MCP token tables:
   RLS enabled + FORCED with NO policy and NO grants to chairback_app, so the
   app role holds zero privileges here and every access goes through the
   owner-executed recovery service. The phone at rest is an HMAC (lookup key)
   plus a token-encrypted copy (the verified Client lookup needs the number);
   the plaintext code is never at rest anywhere. */

CREATE TABLE "PhoneRecoveryCode" (
  "id"              TEXT NOT NULL,
  "purpose"         TEXT NOT NULL,
  "phoneHash"       TEXT NOT NULL,
  "phoneEnc"        TEXT NOT NULL,
  "ipHash"          TEXT NOT NULL,
  "codeHash"        TEXT NOT NULL,
  "attemptCount"    INTEGER NOT NULL DEFAULT 0,
  "expiresAt"       TIMESTAMP(3) NOT NULL,
  "consumedAt"      TIMESTAMP(3),
  "proofHash"       TEXT,
  "proofExpiresAt"  TIMESTAMP(3),
  "proofConsumedAt" TIMESTAMP(3),
  "lastSentAt"      TIMESTAMP(3) NOT NULL,
  "sendCount"       INTEGER NOT NULL DEFAULT 1,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PhoneRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PhoneRecoveryCode_proofHash_key" ON "PhoneRecoveryCode"("proofHash");
CREATE UNIQUE INDEX "PhoneRecoveryCode_purpose_phoneHash_key" ON "PhoneRecoveryCode"("purpose", "phoneHash");
CREATE INDEX "PhoneRecoveryCode_expiresAt_idx" ON "PhoneRecoveryCode"("expiresAt");
CREATE INDEX "PhoneRecoveryCode_ipHash_lastSentAt_idx" ON "PhoneRecoveryCode"("ipHash", "lastSentAt");

/* Only sane purposes, pinned like every other CHECK-constrained vocabulary. */
ALTER TABLE "PhoneRecoveryCode"
  ADD CONSTRAINT "PhoneRecoveryCode_purpose_check"
  CHECK ("purpose" IN ('rewards_recovery'));

/* 🔴 DEFAULT-DENY. Revoke explicitly first: under this database's ALTER
   DEFAULT PRIVILEGES a newly created table may carry grants, and "no grant
   was issued" is not the same as "no privilege is held". Zero policies +
   FORCE means every non-owner role sees nothing and writes nothing. */
REVOKE ALL ON "PhoneRecoveryCode" FROM chairback_app;
ALTER TABLE "PhoneRecoveryCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PhoneRecoveryCode" FORCE ROW LEVEL SECURITY;
