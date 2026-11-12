-- Per-DATE hours for one service: {"2026-11-24": {"w": [{"s":480,"e":930}], "staff": []}}.
--
-- A barber wanted longer hours for one service on the days of Thanksgiving
-- week without touching anything else. Service.hoursWindows is weekly and can
-- only narrow the staff schedule, so there was no way to say it.
--
-- Additive only. Every existing service gets {} - no date carries an entry, so
-- the slot engine behaves exactly as it did before this column existed.
ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "dateHours" JSONB NOT NULL DEFAULT '{}';
