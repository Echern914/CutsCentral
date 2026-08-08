-- Reminder idempotency stamps for SYNCED bookings (Acuity/Square).
--
-- Shops that keep their old calendar have Visit rows and no Appointment row, so
-- the native reminder job (which reads Appointment) never saw them and those
-- shops got no appointment reminders at all. These are the Visit twins of
-- Appointment.reminderSentAt / reminderEmailSentAt.
--
-- Nullable with no default: null means "not reminded yet", which is exactly the
-- correct reading for every row that already exists.
ALTER TABLE "Visit"
  ADD COLUMN IF NOT EXISTS "reminderSentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reminderEmailSentAt" TIMESTAMP(3);

-- The reminder sweep filters on (status, scheduledAt) and then on the two
-- stamps. The existing (shopId, status, scheduledAt) index does not serve a
-- cross-shop scan, so give the job its own narrow one.
CREATE INDEX IF NOT EXISTS "Visit_status_scheduledAt_idx"
  ON "Visit" ("status", "scheduledAt");

-- Seed the lease row for the new cron. withLease() acquires by UPDATE-only, so
-- a job whose name was never seeded silently NEVER RUNS in any deployed
-- environment while its unit tests stay green - which is exactly how
-- acuity-resync once shipped dead. scheduler.leaseSeed.test.ts enforces this.
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt") VALUES
    ('synced-visit-reminders', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
