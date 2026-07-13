-- AI receptionist: shop toggles/billing, appointment holds, conversation state.

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "receptionistEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "receptionistTone" TEXT,
ADD COLUMN     "receptionistSubscriptionStatus" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "receptionistCompAccess" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "receptionistTermsAcceptedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "holdExpiresAt" TIMESTAMP(3),
ADD COLUMN     "bookedVia" TEXT;

-- CreateIndex
CREATE INDEX "Appointment_status_holdExpiresAt_idx" ON "Appointment"("status", "holdExpiresAt");

-- CreateTable
CREATE TABLE "ReceptionistConversation" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "clientId" TEXT,
    "phone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "processingSince" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceptionistConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceptionistMessage" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceptionistMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReceptionistConversation_shopId_phone_status_idx" ON "ReceptionistConversation"("shopId", "phone", "status");

-- CreateIndex
CREATE INDEX "ReceptionistConversation_phone_status_lastMessageAt_idx" ON "ReceptionistConversation"("phone", "status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "ReceptionistConversation_status_lastMessageAt_idx" ON "ReceptionistConversation"("status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "ReceptionistMessage_conversationId_createdAt_idx" ON "ReceptionistMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ReceptionistMessage_shopId_createdAt_idx" ON "ReceptionistMessage"("shopId", "createdAt");

-- AddForeignKey
ALTER TABLE "ReceptionistConversation" ADD CONSTRAINT "ReceptionistConversation_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistConversation" ADD CONSTRAINT "ReceptionistConversation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistMessage" ADD CONSTRAINT "ReceptionistMessage_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionistMessage" ADD CONSTRAINT "ReceptionistMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ReceptionistConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS defense-in-depth: same tenant-isolation pattern as WaitlistEntry and the
-- other tenant tables. The dashboard path (forShop -> SET ROLE chairback_app)
-- is enforced; the Twilio-webhook path (no shop session) inserts as the
-- connection owner and bypasses FORCE RLS, exactly like the public
-- waitlist/request/Twilio-STOP writes.
GRANT SELECT, INSERT, UPDATE, DELETE ON "ReceptionistConversation" TO chairback_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ReceptionistMessage" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ReceptionistConversation', 'ReceptionistMessage']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING ("shopId" = current_shop_id())
        WITH CHECK ("shopId" = current_shop_id());
    $f$, t);
  END LOOP;
END
$$;
