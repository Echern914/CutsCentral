-- DURABLE BROADCAST DELIVERY.
--
-- The first cut answered 202 and then ran the whole blast in a floating
-- promise. A deploy, a crash or a restart in the seconds after that response
-- stranded the broadcast in SENDING forever: nothing retried it, nothing
-- finalised it, and the barber had been told it was on its way. This migration
-- turns each intended recipient into a unit of durable, claimable work - the
-- same shape EmailIntent already uses for cancellation mail.

-- ── The recipient row becomes the queue ─────────────────────────────────────
-- Real provider dispatches only: a worker that died before contacting Resend
-- must not have spent this recipient's budget.
ALTER TABLE "BroadcastSend" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
-- When this recipient's idempotency key was first put in front of the
-- provider. The 24h collapse window runs from then, not from row creation.
ALTER TABLE "BroadcastSend" ADD COLUMN "firstProviderAttemptAt" TIMESTAMP(3);
-- Write-ahead: set in the same statement that reserves an attempt, which
-- commits BEFORE the request leaves. A process that dies after acceptance but
-- before the response is handled still leaves a row that says so.
ALTER TABLE "BroadcastSend" ADD COLUMN "lastAttemptAmbiguous" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BroadcastSend" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
ALTER TABLE "BroadcastSend" ADD COLUMN "claimedAt" TIMESTAMP(3);
ALTER TABLE "BroadcastSend" ADD COLUMN "claimToken" TEXT;
ALTER TABLE "BroadcastSend" ADD COLUMN "lastError" TEXT;
ALTER TABLE "BroadcastSend" ADD COLUMN "messageId" TEXT;
ALTER TABLE "BroadcastSend" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
-- The claim scan: due, unclaimed or stale, oldest first.
CREATE INDEX "BroadcastSend_status_nextAttemptAt_idx"
  ON "BroadcastSend"("status", "nextAttemptAt");

-- ── The broadcast row learns what it actually costs ─────────────────────────
ALTER TABLE "Broadcast" ADD COLUMN "emailsReserved" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Broadcast" ADD COLUMN "queuedAt" TIMESTAMP(3);
CREATE INDEX "Broadcast_status_idx" ON "Broadcast"("status");

-- ── The allowance row that exists to be locked ──────────────────────────────
-- Counting sent rows to decide whether a blast fits is a check-then-act race:
-- two sends both read "400 left", both decide 400 fits, and the shop mails 800
-- on a 400 allowance. The reservation is taken with this row locked FOR UPDATE
-- inside the same transaction that freezes the audience.
CREATE TABLE "ShopEmailQuota" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopEmailQuota_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ShopEmailQuota_shopId_periodStart_key"
  ON "ShopEmailQuota"("shopId", "periodStart");
ALTER TABLE "ShopEmailQuota" ADD CONSTRAINT "ShopEmailQuota_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A reservation may never go negative: releasing more than was taken would
-- hand a shop free allowance and hide the bug that did it.
ALTER TABLE "ShopEmailQuota" ADD CONSTRAINT "ShopEmailQuota_reserved_nonneg"
  CHECK ("reserved" >= 0);

GRANT SELECT, INSERT, UPDATE, DELETE ON "ShopEmailQuota" TO chairback_app;
ALTER TABLE "ShopEmailQuota" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopEmailQuota" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ShopEmailQuota";
CREATE POLICY tenant_isolation ON "ShopEmailQuota"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());

-- ── A dedicated unsubscribe credential ─────────────────────────────────────
-- The footer used to carry Client.magicToken, which is that customer's whole
-- rewards session - their visits, punches, appointments and settings - mailed
-- to them every time a shop ran a promotion. This grants one boolean instead.
-- Only the digest is stored; the raw value is derived, never persisted, so a
-- leaked backup yields no working links. Rewards sessions are untouched:
-- magicToken is not read, written or rotated here.
ALTER TABLE "Client" ADD COLUMN "unsubscribeTokenHash" TEXT;
CREATE UNIQUE INDEX "Client_unsubscribeTokenHash_key"
  ON "Client"("unsubscribeTokenHash");

-- The provider's refusal, which is NOT the person's choice. Recording a hard
-- bounce as "they unsubscribed" invents a decision the customer never made.
ALTER TABLE "Client" ADD COLUMN "emailSuppressedAt" TIMESTAMP(3);
ALTER TABLE "Client" ADD COLUMN "emailSuppressionReason" TEXT;

-- ── A bounce has to be attributable to somebody ────────────────────────────
-- An id, not an address: this table still stores no recipient, no subject and
-- no body, which is what made it safe to build in the first place.
ALTER TABLE "EmailDelivery" ADD COLUMN "clientId" TEXT;
CREATE INDEX "EmailDelivery_clientId_idx" ON "EmailDelivery"("clientId");

-- ── The scheduler lease ────────────────────────────────────────────────────
-- 🔴 withLease() ACQUIRES BY UPDATE ONLY, so a job whose name was never seeded
-- here matches zero rows and silently never runs in ANY deployed environment,
-- while its own unit test stays green. That is exactly how acuity-resync
-- shipped dead. scheduler.leaseSeed.test.ts fails without this line.
-- expiresAt = now() is already in the past by the first tick, so the first
-- acquire wins. Idempotent via ON CONFLICT, matching every other *_lease_seed.
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt") VALUES
    ('broadcast-worker', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
