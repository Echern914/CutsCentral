-- Financial integrity (2026-09-03 audit). Additive only: new nullable
-- columns, one new platform table, one job-lease seed. Nothing is rewritten,
-- nothing is dropped, no existing row changes value.

-- Shop: ordering guards for the subscription webhook. `event.created` of the
-- last applied base-subscription/checkout event, and the same for the
-- receptionist add-on's own subscription. NULL = nothing applied yet.
ALTER TABLE "Shop" ADD COLUMN "subscriptionEventCreated" INTEGER;
ALTER TABLE "Shop" ADD COLUMN "receptionistEventCreated" INTEGER;

-- Referral: which invoice qualified it, which Stripe balance transaction the
-- credit landed as, and a review flag a refund/dispute/credit note can raise.
ALTER TABLE "Referral" ADD COLUMN "qualifyingInvoiceId" TEXT;
ALTER TABLE "Referral" ADD COLUMN "stripeBalanceTransactionId" TEXT;
ALTER TABLE "Referral" ADD COLUMN "reviewFlaggedAt" TIMESTAMP(3);
ALTER TABLE "Referral" ADD COLUMN "reviewReason" TEXT;
CREATE UNIQUE INDEX "Referral_stripeBalanceTransactionId_key" ON "Referral"("stripeBalanceTransactionId");

-- Payment: an ambiguous Stripe outcome is marked, never guessed.
ALTER TABLE "Payment" ADD COLUMN "ambiguousAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "reconciledAt" TIMESTAMP(3);

-- Webhook receipts: one row per Stripe event id ever accepted by either
-- endpoint. The unique index IS the replay guard.
CREATE TABLE "StripeEventReceipt" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "account" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "StripeEventReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StripeEventReceipt_eventId_key" ON "StripeEventReceipt"("eventId");
CREATE INDEX "StripeEventReceipt_status_receivedAt_idx" ON "StripeEventReceipt"("status", "receivedAt");
CREATE INDEX "StripeEventReceipt_type_receivedAt_idx" ON "StripeEventReceipt"("type", "receivedAt");
ALTER TABLE "StripeEventReceipt"
  ADD CONSTRAINT "StripeEventReceipt_status_check"
  CHECK ("status" IN ('received', 'processed', 'failed'));

/* Platform-global, default-deny for the tenant role, like StripeWebhookEvent. */
REVOKE ALL ON "StripeEventReceipt" FROM chairback_app;
ALTER TABLE "StripeEventReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StripeEventReceipt" FORCE ROW LEVEL SECURITY;

/* The payments reconciler. A scheduled job whose name has no job_lease row
   NEVER runs - withLease acquires by UPDATE only. */
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt")
VALUES ('payments-reconcile', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
