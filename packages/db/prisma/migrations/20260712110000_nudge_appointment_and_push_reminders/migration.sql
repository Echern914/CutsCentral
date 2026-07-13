-- Barber "come early" nudges + automatic push reminders (both push-only).

-- Nudge rows can now be scoped to ONE appointment (kind "checkin_nudge" /
-- "checkin_nudge_reply"); the max-2-per-appointment rate limit counts by this
-- FK. SetNull keeps the audit row if the appointment is deleted.
ALTER TABLE "Nudge" ADD COLUMN "appointmentId" TEXT;
ALTER TABLE "Nudge" ADD CONSTRAINT "Nudge_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Nudge_appointmentId_kind_idx" ON "Nudge"("appointmentId", "kind");

-- Push-reminder stamps: a third reminder channel (besides SMS + email) with two
-- tiers. Each stamp is claimed atomically (updateMany WHERE null) before the
-- send, so a double/concurrent run can never send twice.
ALTER TABLE "Appointment"
  ADD COLUMN "reminder24hPushSentAt" TIMESTAMP(3),
  ADD COLUMN "reminder2hPushSentAt"  TIMESTAMP(3);

-- Per-shop reminder toggles. Deliberately DEFAULT TRUE (unlike other toggles):
-- reminders are expected behavior and push is free; the default backfills every
-- existing shop ON. Barbers who want neither turn both off.
ALTER TABLE "Shop"
  ADD COLUMN "pushReminder24hEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "pushReminder2hEnabled"  BOOLEAN NOT NULL DEFAULT true;

-- Seed the lease row for the new cron job. CRITICAL: withLease acquires by
-- UPDATE-ing an existing row - a job whose lease was never seeded NEVER runs.
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt") VALUES
  ('push-reminders', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
