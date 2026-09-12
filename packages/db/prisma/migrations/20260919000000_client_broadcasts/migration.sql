-- Client broadcasts: one message from a shop to many of its clients, by email
-- or by app notification. NEVER by SMS - a text to 2,900 clients costs real
-- money per message and would empty a shop's monthly allowance in one tap, so
-- the channel enum simply has no value for it.
--
-- Additive: two new tenant tables and two Client columns with defaults.

CREATE TYPE "BroadcastChannel" AS ENUM ('email', 'push');
CREATE TYPE "BroadcastStatus" AS ENUM ('DRAFT', 'SENDING', 'SENT', 'FAILED');
CREATE TYPE "BroadcastSendStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- The CAN-SPAM unsubscribe, kept separate from the TCPA "optedOut" STOP gate.
-- A client who stopped texts has not asked to stop hearing from the shop
-- entirely, and one who unsubscribed from marketing email must keep getting
-- their booking confirmations.
ALTER TABLE "Client" ADD COLUMN "emailOptedOut" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Client" ADD COLUMN "emailOptedOutAt" TIMESTAMP(3);

CREATE TABLE "Broadcast" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "channel" "BroadcastChannel" NOT NULL,
    "audienceTiers" "LoyaltyTier"[] DEFAULT ARRAY[]::"LoyaltyTier"[],
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'DRAFT',
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Broadcast_shopId_createdAt_idx" ON "Broadcast"("shopId", "createdAt");
CREATE INDEX "Broadcast_shopId_status_idx" ON "Broadcast"("shopId", "status");

CREATE TABLE "BroadcastSend" (
    "id" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" "BroadcastSendStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BroadcastSend_pkey" PRIMARY KEY ("id")
);
-- 🔴 THE AT-MOST-ONCE GUARANTEE. A retried or double-tapped send can never
-- mail the same client twice, and a run that dies halfway is resumable: the
-- rows it already wrote are skipped by the next pass.
CREATE UNIQUE INDEX "BroadcastSend_broadcastId_clientId_key"
  ON "BroadcastSend"("broadcastId", "clientId");
CREATE INDEX "BroadcastSend_shopId_createdAt_idx" ON "BroadcastSend"("shopId", "createdAt");
CREATE INDEX "BroadcastSend_broadcastId_status_idx" ON "BroadcastSend"("broadcastId", "status");

ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BroadcastSend" ADD CONSTRAINT "BroadcastSend_broadcastId_fkey"
  FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BroadcastSend" ADD CONSTRAINT "BroadcastSend_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BroadcastSend" ADD CONSTRAINT "BroadcastSend_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/* Tenant isolation, like every other shop table. */
GRANT SELECT, INSERT, UPDATE, DELETE ON "Broadcast" TO chairback_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "BroadcastSend" TO chairback_app;
ALTER TABLE "Broadcast" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Broadcast" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Broadcast";
CREATE POLICY tenant_isolation ON "Broadcast"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
ALTER TABLE "BroadcastSend" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BroadcastSend" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "BroadcastSend";
CREATE POLICY tenant_isolation ON "BroadcastSend"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
