-- Per-DATE price overrides on a service (the holiday knob).
-- Shape: {"YYYY-MM-DD": <price>} in shop-local calendar dates, e.g.
-- {"2026-12-24": 75}. A weekday map cannot express "Christmas Eve", so this is
-- its own layer and the most specific one in engines/pricing.ts.
-- Defaulted + NOT NULL so every existing row reads as "no special dates" and no
-- code path has to handle a null blob.
ALTER TABLE "Service"
  ADD COLUMN IF NOT EXISTS "dateOverrides" JSONB NOT NULL DEFAULT '{}';
