-- "Book your next one?" push, ~30 minutes after the chair empties.
--
-- Per-shop kill switch, defaulted ON to match the other push tiers.
ALTER TABLE "Shop"
  ADD COLUMN IF NOT EXISTS "rebookPushEnabled" BOOLEAN NOT NULL DEFAULT true;

-- At-most-once stamps, one per row type. NATIVE bookings are Appointment rows;
-- shops that kept Acuity/Square have Visit rows and NO Appointment, so a job
-- that reads only Appointment reaches none of them (that was the #212 bug).
-- Both get a stamp; the engine skips any Visit with a linked appointment so a
-- promoted native booking is not nudged twice for one haircut.
--
-- Nullable with no default: null = "not nudged", the correct reading for every
-- row that already exists.
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "rebookPromptSentAt" TIMESTAMP(3);
ALTER TABLE "Visit"       ADD COLUMN IF NOT EXISTS "rebookPromptSentAt" TIMESTAMP(3);

-- The sweep scans cross-shop by (status, endsAt/endAt) and then by the stamp.
-- The per-shop indexes do not serve a cross-shop scan.
CREATE INDEX IF NOT EXISTS "Appointment_status_endsAt_idx" ON "Appointment" ("status", "endsAt");
CREATE INDEX IF NOT EXISTS "Visit_status_endAt_idx"        ON "Visit" ("status", "endAt");

-- Seed the lease row for the new cron. withLease() acquires by UPDATE-only, so
-- a job whose name was never seeded silently NEVER RUNS in any deployed
-- environment while its unit tests stay green - which is exactly how
-- acuity-resync once shipped dead. scheduler.leaseSeed.test.ts enforces this.
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt") VALUES
    ('rebook-nudges', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
