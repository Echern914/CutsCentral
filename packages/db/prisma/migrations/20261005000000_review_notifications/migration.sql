-- Review notifications: the durable promise to tell somebody a review arrived.
--
-- Before this, `POST /s/:slug/review` created the Review and then called Twilio
-- inline, once, to Shop.notifyPhone. A shop without a notifyPhone - which is
-- the shop this was reported from - got nothing at all: no text, no push, no
-- retry, and no row saying anything had been meant to happen. This table is
-- that row.
--
-- 🔴 THIS MIGRATION DELIBERATELY ENQUEUES NOTHING.
-- There is no backfill here and there must never be one. Every Review that
-- already exists predates the outbox, and creating pending rows for them would
-- have the worker text and push a shop about reviews that are days or months
-- old, the moment this deploys. Those reviews are surfaced the correct way
-- instead - by the pending-review badge, which is derived from the Review rows
-- themselves and therefore shows the whole backlog immediately without sending
-- anything. A one-time "N reviews are waiting" summary, if anyone wants one, is
-- a deliberate operator action and not a side effect of a schema change.

CREATE TABLE "ReviewNotification" (
  "id"                     TEXT NOT NULL,
  "shopId"                 TEXT NOT NULL,
  "reviewId"               TEXT NOT NULL,
  /* The barber/manager this is for. Re-authorised at delivery time. */
  "userId"                 TEXT NOT NULL,
  "channel"                TEXT NOT NULL,
  "status"                 TEXT NOT NULL DEFAULT 'pending',
  /* Real provider dispatches only - a claim is not an attempt. */
  "attempts"               INTEGER NOT NULL DEFAULT 0,
  "firstProviderAttemptAt" TIMESTAMP(3),
  /* Write-ahead: committed BEFORE the request leaves, so a process that dies
     after the provider accepted still leaves a row that says so. */
  "lastAttemptAmbiguous"   BOOLEAN NOT NULL DEFAULT false,
  "nextAttemptAt"          TIMESTAMP(3),
  /* The lease. A DEADLINE, not "claimedAt + a constant in the worker": a TTL
     change in code then cannot retroactively reinterpret claims in flight. */
  "leaseUntil"             TIMESTAMP(3),
  /* The identity of the current claim; every later write compare-and-sets it. */
  "lockedBy"               TEXT,
  /* Fixed classification only - never provider prose, never a contact, and
     never any of the customer's review text. */
  "lastError"              TEXT,
  "providerMessageId"      TEXT,
  "sentAt"                 TIMESTAMP(3),
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ReviewNotification_pkey" PRIMARY KEY ("id")
);

/* 🔴 THE KEY THE WHOLE DESIGN RESTS ON. Two concurrent submits, a retried
   enqueue, or a worker replaying its own batch all collapse onto one row per
   recipient per channel. Without it, "at least once" would have no ceiling. */
CREATE UNIQUE INDEX "ReviewNotification_reviewId_userId_channel_key"
  ON "ReviewNotification"("reviewId", "userId", "channel");

/* The claim scan: pending and due, oldest first. */
CREATE INDEX "ReviewNotification_status_nextAttemptAt_idx"
  ON "ReviewNotification"("status", "nextAttemptAt");
CREATE INDEX "ReviewNotification_shopId_createdAt_idx"
  ON "ReviewNotification"("shopId", "createdAt");
CREATE INDEX "ReviewNotification_reviewId_idx"
  ON "ReviewNotification"("reviewId");
CREATE INDEX "ReviewNotification_userId_idx"
  ON "ReviewNotification"("userId");

ALTER TABLE "ReviewNotification"
  ADD CONSTRAINT "ReviewNotification_channel_check"
  CHECK ("channel" IN ('push', 'sms', 'email'));
ALTER TABLE "ReviewNotification"
  ADD CONSTRAINT "ReviewNotification_status_check"
  CHECK ("status" IN ('pending', 'sent', 'skipped', 'failed', 'abandoned'));
/* Nothing terminal may still be holding a lease: a settled row that kept its
   lockedBy would be invisible to the recovery scan if it were ever reopened. */
ALTER TABLE "ReviewNotification"
  ADD CONSTRAINT "ReviewNotification_lease_only_while_pending_check"
  CHECK ("status" = 'pending' OR ("leaseUntil" IS NULL AND "lockedBy" IS NULL));

ALTER TABLE "ReviewNotification"
  ADD CONSTRAINT "ReviewNotification_shopId_fkey" FOREIGN KEY ("shopId")
  REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReviewNotification"
  ADD CONSTRAINT "ReviewNotification_reviewId_fkey" FOREIGN KEY ("reviewId")
  REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReviewNotification"
  ADD CONSTRAINT "ReviewNotification_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The worker's lease ----------------------------------------------------------

/* 🔴 withLease() ACQUIRES BY UPDATE ONLY: a job whose name was never seeded
   matches zero rows and silently never runs in any deployed environment, while
   its own unit test stays green. scheduler.leaseSeed.test.ts fails without
   this line. */
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt") VALUES
    ('review-notify-outbox', '', now(), now())
ON CONFLICT ("name") DO NOTHING;

-- Tenant table ----------------------------------------------------------------

/* The same posture as "Review" itself: the app role only ever reaches it
   inside runWithShop, and never across shops. The WORKER reads it as the
   connection owner (runAsOwner), which is how it can drain every shop's queue
   from one pass without a shop session. */
GRANT SELECT, INSERT, UPDATE, DELETE ON "ReviewNotification" TO chairback_app;
ALTER TABLE "ReviewNotification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewNotification" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ReviewNotification";
CREATE POLICY tenant_isolation ON "ReviewNotification"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
