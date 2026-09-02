-- Affiliate credit execution: the outbox that turns an AVAILABLE reward into a
-- Stripe customer-balance credit, exactly once.
--
-- The EmailIntent shape, deliberately: claim token + TTL, a write-ahead
-- ambiguity marker set in the attempt reservation, a provider idempotency
-- window (Stripe honours a key for 24h), fixed error classifications. The
-- reward's status is the source of truth; Stripe's balance is only the
-- mechanism that applies it.
CREATE TABLE IF NOT EXISTS "AffiliateCreditOperation" (
  "id"                         TEXT NOT NULL,
  "rewardId"                   TEXT NOT NULL,
  "affiliateAccountId"         TEXT NOT NULL,
  "shopId"                     TEXT NOT NULL,
  "status"                     TEXT NOT NULL DEFAULT 'PENDING',
  "amountCents"                INTEGER NOT NULL,
  "appliedCents"               INTEGER,
  "currency"                   TEXT NOT NULL,
  "stripeCustomerId"           TEXT,
  "stripeBalanceTransactionId" TEXT,
  "attempts"                   INTEGER NOT NULL DEFAULT 0,
  "firstProviderAttemptAt"     TIMESTAMP(3),
  "lastAttemptAmbiguous"       BOOLEAN NOT NULL DEFAULT false,
  "nextAttemptAt"              TIMESTAMP(3),
  "claimedAt"                  TIMESTAMP(3),
  "claimToken"                 TEXT,
  "lastError"                  TEXT,
  "appliedAt"                  TIMESTAMP(3),
  "createdAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AffiliateCreditOperation_pkey" PRIMARY KEY ("id")
);

/* One operation per reward, ever - the second layer of exactly-once under
   the Stripe idempotency key. */
CREATE UNIQUE INDEX IF NOT EXISTS "AffiliateCreditOperation_rewardId_key"
  ON "AffiliateCreditOperation"("rewardId");
CREATE UNIQUE INDEX IF NOT EXISTS "AffiliateCreditOperation_stripeBalanceTransactionId_key"
  ON "AffiliateCreditOperation"("stripeBalanceTransactionId");
CREATE INDEX IF NOT EXISTS "AffiliateCreditOperation_status_nextAttemptAt_idx"
  ON "AffiliateCreditOperation"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "AffiliateCreditOperation_affiliateAccountId_status_idx"
  ON "AffiliateCreditOperation"("affiliateAccountId", "status");

ALTER TABLE "AffiliateCreditOperation" DROP CONSTRAINT IF EXISTS "AffiliateCreditOperation_status_check";
ALTER TABLE "AffiliateCreditOperation" ADD CONSTRAINT "AffiliateCreditOperation_status_check"
  CHECK ("status" IN ('PENDING','APPLIED','FAILED','ABANDONED','CANCELED'));
ALTER TABLE "AffiliateCreditOperation" DROP CONSTRAINT IF EXISTS "AffiliateCreditOperation_amount_check";
ALTER TABLE "AffiliateCreditOperation" ADD CONSTRAINT "AffiliateCreditOperation_amount_check"
  CHECK ("amountCents" > 0 AND ("appliedCents" IS NULL OR ("appliedCents" > 0 AND "appliedCents" <= "amountCents")));
/* An APPLIED operation says what Stripe returned and when. */
ALTER TABLE "AffiliateCreditOperation" DROP CONSTRAINT IF EXISTS "AffiliateCreditOperation_applied_shape_check";
ALTER TABLE "AffiliateCreditOperation" ADD CONSTRAINT "AffiliateCreditOperation_applied_shape_check"
  CHECK ("status" <> 'APPLIED' OR ("appliedAt" IS NOT NULL AND "appliedCents" IS NOT NULL));

/* 🔴 DEFAULT-DENY, like every other affiliate and platform table. */
REVOKE ALL ON "AffiliateCreditOperation" FROM chairback_app;
ALTER TABLE "AffiliateCreditOperation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AffiliateCreditOperation" FORCE ROW LEVEL SECURITY;

/* The execution job. A scheduled job whose name has no job_lease row NEVER
   runs - withLease acquires by UPDATE only. */
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt")
VALUES ('affiliate-credit-execution', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
