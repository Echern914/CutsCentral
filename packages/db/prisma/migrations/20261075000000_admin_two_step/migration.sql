-- Admin two-step (2026-10-22): the admin portal opens only for a session that
-- has passed a second check - an authenticator-app code, or an emailed one as
-- the fallback. Additive only: four nullable columns and two new tables.

-- The authenticator. The secret is sealed with TOKEN_ENCRYPTION_KEY (never
-- stored in the clear); PENDING holds one shown for setup until confirmed.
ALTER TABLE "User" ADD COLUMN "adminTotpSecretEnc" TEXT;
ALTER TABLE "User" ADD COLUMN "adminTotpPendingEnc" TEXT;
ALTER TABLE "User" ADD COLUMN "adminTotpEnabledAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "adminTotpLastStep" INTEGER;

-- A session that passed the check: bound to the session token's digest AND
-- to a random pass token (an httpOnly cookie) - a session key alone, leaked,
-- can mint sessions but cannot produce the pass.
CREATE TABLE "AdminStepUp" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionDigest" TEXT NOT NULL,
    "passHash" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminStepUp_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AdminStepUp_method_check" CHECK ("method" IN ('totp', 'email'))
);

CREATE UNIQUE INDEX "AdminStepUp_passHash_key" ON "AdminStepUp"("passHash");

CREATE INDEX "AdminStepUp_userId_sessionDigest_expiresAt_idx" ON "AdminStepUp"("userId", "sessionDigest", "expiresAt");

ALTER TABLE "AdminStepUp" ADD CONSTRAINT "AdminStepUp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An emailed code: digest only, short-lived, few tries.
CREATE TABLE "AdminEmailCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminEmailCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminEmailCode_userId_createdAt_idx" ON "AdminEmailCode"("userId", "createdAt");

ALTER TABLE "AdminEmailCode" ADD CONSTRAINT "AdminEmailCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Default-deny ------------------------------------------------------------------

/* Same shape as the customer-account tables: revoke explicitly (default
   privileges may grant a new table to the tenant role), then zero policies +
   FORCE, so the tenant role sees and writes nothing. The API reads and writes
   these as the owner only (runAsOwner). */
REVOKE ALL ON "AdminStepUp" FROM chairback_app;
REVOKE ALL ON "AdminEmailCode" FROM chairback_app;

ALTER TABLE "AdminStepUp" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdminStepUp" FORCE ROW LEVEL SECURITY;
ALTER TABLE "AdminEmailCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdminEmailCode" FORCE ROW LEVEL SECURITY;
