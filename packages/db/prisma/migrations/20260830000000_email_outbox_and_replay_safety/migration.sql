/* Durable email outbox + replay-safe delivery ledger.

   Two corrections from the cold review:

   1. The cancellation email was claim-then-send: the "sent" stamp was taken
      BEFORE the provider call, so a crash in between permanently suppressed
      the message while the appointment recorded it as delivered. The intent
      now commits inside the cancellation transaction and a lease-guarded
      worker drains it.

   2. A webhook can arrive before the sender's own metadata write, and svix
      retries the same delivery. Events are now deduplicated by svix id, and
      an event for an unknown message creates the row rather than discarding
      the event. */

CREATE TABLE "EmailIntent" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailIntent_pkey" PRIMARY KEY ("id")
);

/* 🔴 THE EXACTLY-ONCE GUARANTEE. Two concurrent cancellations of the same
   occurrence race this INSERT; one wins, the other is a no-op. The same value
   is sent as Resend's Idempotency-Key, so even a retried HTTP attempt is
   collapsed by the provider. */
CREATE UNIQUE INDEX "EmailIntent_idempotencyKey_key" ON "EmailIntent"("idempotencyKey");
CREATE INDEX "EmailIntent_status_createdAt_idx" ON "EmailIntent"("status", "createdAt");
CREATE INDEX "EmailIntent_appointmentId_idx" ON "EmailIntent"("appointmentId");

ALTER TABLE "EmailIntent"
  ADD CONSTRAINT "EmailIntent_kind_check"
  CHECK ("kind" IN ('appointment_canceled'));
ALTER TABLE "EmailIntent"
  ADD CONSTRAINT "EmailIntent_status_check"
  CHECK ("status" IN ('PENDING','SENT','FAILED','ABANDONED'));

CREATE TABLE "EmailWebhookEvent" (
    "id" TEXT NOT NULL,
    "svixId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailWebhookEvent_pkey" PRIMARY KEY ("id")
);

/* The replay guard: one row per svix delivery id, so a retried webhook is
   recognised and changes nothing. */
CREATE UNIQUE INDEX "EmailWebhookEvent_svixId_key" ON "EmailWebhookEvent"("svixId");
CREATE INDEX "EmailWebhookEvent_messageId_idx" ON "EmailWebhookEvent"("messageId");

/* Lets an event that beat its own dispatch write be recognised and completed
   later, instead of being thrown away. */
ALTER TABLE "EmailDelivery"
  ADD COLUMN IF NOT EXISTS "awaitingDispatchMeta" BOOLEAN NOT NULL DEFAULT false;

/* 🔴 EmailIntent IS TENANT DATA, not a platform table, because of WHERE it is
   written: the intent must commit inside the cancellation's own transaction,
   and that transaction runs as chairback_app under runWithShop. A default-deny
   table would make the app role unable to insert, so the atomic guarantee
   would be impossible - the enqueue would have to move outside the
   transaction, which is the very bug this migration exists to fix.

   So it gets the standard tenant_isolation treatment: the app role may write,
   and the policy confines it to its own shop. The outbox WORKER reads across
   shops as the owner, which bypasses RLS by design. */
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chairback_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON "EmailIntent" TO chairback_app';
  END IF;
END
$$;

ALTER TABLE "EmailIntent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailIntent" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "EmailIntent";
CREATE POLICY tenant_isolation ON "EmailIntent"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());

/* EmailWebhookEvent stays DEFAULT-DENY: it is written only by the webhook
   receiver as the owner, has no tenant column, and nothing in a request path
   should be able to read or forge a provider delivery record. Revoke first -
   a new table can carry grants under this database's default privileges. */
REVOKE ALL ON "EmailWebhookEvent" FROM chairback_app;
ALTER TABLE "EmailWebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailWebhookEvent" FORCE ROW LEVEL SECURITY;

/* Lease seed for the outbox worker. A scheduled name with no job_lease row
   NEVER runs (withLease acquires by UPDATE only).
   scheduler.leaseSeed.test.ts asserts this literal: 'email-outbox'. */
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt")
VALUES ('email-outbox', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
