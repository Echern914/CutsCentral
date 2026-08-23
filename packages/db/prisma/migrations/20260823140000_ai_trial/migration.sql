-- A Premium shop's 14-day free run at Premium AI.
--
-- Three additive nullable columns and a defaulted int. No Stripe object is
-- touched by this feature at all: the shop keeps paying $34.99 for the whole
-- window and `plan` stays "pro", so there is no proration, no refund surface,
-- and nothing to unwind if they walk away. The entitlement is read off
-- aiTrialEndsAt by hasReceptionistEntitlement().
--
-- aiTrialStartedAt is the used-once marker and is never nulled, so letting a
-- trial lapse cannot buy a second one.

ALTER TABLE "Shop"
  ADD COLUMN "aiTrialStartedAt"     TIMESTAMP(3),
  ADD COLUMN "aiTrialEndsAt"        TIMESTAMP(3),
  ADD COLUMN "aiTrialReminderStage" INTEGER NOT NULL DEFAULT 0;

-- The reminder sweep asks "whose AI trial is nearly up", which is a small slice
-- of a table scanned by plenty of other queries.
CREATE INDEX "Shop_aiTrialEndsAt_idx" ON "Shop"("aiTrialEndsAt")
  WHERE "aiTrialEndsAt" IS NOT NULL;

-- Nothing to backfill: no shop has taken this trial, and a null aiTrialEndsAt
-- reads as "no AI trial", which is exactly right for every existing row.

-- 🔴 THE LEASE SEED. withLease() acquires by UPDATE-only, so a scheduled job
-- whose name was never seeded here silently never runs in ANY deployed
-- environment - while its own unit test, which inserts the row by hand, stays
-- green. That is exactly how acuity-resync shipped dead. scheduler.leaseSeed
-- .test.ts fails without this line.
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt") VALUES
    ('ai-trial-reminders', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
