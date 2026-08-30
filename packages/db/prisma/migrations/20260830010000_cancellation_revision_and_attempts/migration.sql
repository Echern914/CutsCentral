/* Bind each email intent to a real cancellation OCCURRENCE, and account for
   provider attempts honestly.

   The exactly-once guarantee was false under real clocks: the idempotency key
   was built from each request's `now`, so two concurrent cancellations
   produced two different "unique" keys and two emails. The suite only passed
   because every racer was handed the same fixed timestamp.

   The identity of a cancellation is now a persisted revision that only an
   atomic winning transition increments - not a wall clock. */

ALTER TABLE "Appointment"
  ADD COLUMN IF NOT EXISTS "cancellationRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "EmailIntent"
  ADD COLUMN IF NOT EXISTS "cancellationRevision" INTEGER,
  ADD COLUMN IF NOT EXISTS "firstProviderAttemptAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3);

/* SUPERSEDED: the appointment was restored, or canceled again on a newer
   revision, so this intent describes a cancellation that no longer stands.
   SUPPRESSED: email was unconfigured or DRY_RUN when the worker reached it -
   terminal on purpose, so enabling email later cannot blast customers with
   cancellations they were never told about at the time. */
ALTER TABLE "EmailIntent" DROP CONSTRAINT IF EXISTS "EmailIntent_status_check";
ALTER TABLE "EmailIntent"
  ADD CONSTRAINT "EmailIntent_status_check"
  CHECK ("status" IN ('PENDING','SENT','FAILED','ABANDONED','SUPERSEDED','SUPPRESSED'));

/* The worker now orders by when a row is next due, not by creation. */
DROP INDEX IF EXISTS "EmailIntent_status_createdAt_idx";
CREATE INDEX IF NOT EXISTS "EmailIntent_status_nextAttemptAt_idx"
  ON "EmailIntent"("status", "nextAttemptAt");
