/* Email delivery ledger: what actually happened to a transactional email.

   Carries NO recipient address and NO body - the provider message id is the
   join key and shopId/appointmentId are the correlation. Additive; nothing
   reads it until the webhook and the admin view do. */

CREATE TABLE "EmailDelivery" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "shopId" TEXT,
    "appointmentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "failureClass" TEXT,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailDelivery_messageId_key" ON "EmailDelivery"("messageId");
CREATE INDEX "EmailDelivery_shopId_sentAt_idx" ON "EmailDelivery"("shopId", "sentAt");
CREATE INDEX "EmailDelivery_status_sentAt_idx" ON "EmailDelivery"("status", "sentAt");
CREATE INDEX "EmailDelivery_appointmentId_idx" ON "EmailDelivery"("appointmentId");

/* Fixed vocabularies, pinned now rather than altered under traffic. */
ALTER TABLE "EmailDelivery"
  ADD CONSTRAINT "EmailDelivery_status_check"
  CHECK ("status" IN ('sent','delivered','bounced','complained','deferred','failed'));
ALTER TABLE "EmailDelivery"
  ADD CONSTRAINT "EmailDelivery_failureClass_check"
  CHECK ("failureClass" IS NULL OR "failureClass" IN
    ('hard_bounce','soft_bounce','complaint','provider_error','deferred'));

/* 🔴 DEFAULT-DENY, like every other platform-scoped table: this is not tenant
   data reachable by the app role, and every read goes through an
   owner-executed service. Revoke explicitly first - a newly created table can
   carry grants under this database's default privileges. */
REVOKE ALL ON "EmailDelivery" FROM chairback_app;
ALTER TABLE "EmailDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailDelivery" FORCE ROW LEVEL SECURITY;
