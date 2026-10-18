-- Holiday NAMES (Drick, Oct 2026: "need to be able to edit the holiday and
-- name it").
--
-- Why the existing storage can't hold it: Service.dateOverrides is a per-service
-- {"YYYY-MM-DD": price} map that ~20 pricing callers read as plain numbers, and
-- a name belongs to the shop's DATE, not to each service - so it gets one
-- shop-level {"YYYY-MM-DD": "Thanksgiving"} map instead of reshaping prices.
ALTER TABLE "Shop" ADD COLUMN "holidayNames" JSONB NOT NULL DEFAULT '{}';

-- SPECIAL DAYS (same ask: "completely modify how my Thanksgiving day looks").
-- A special day is targeted slots plus blocks over the rest of the chair's
-- day; the blocks carry pattern 'special_day' (and groupId = the slots' rule)
-- so they can be listed and removed with their openings. Why the existing
-- patterns can't: each of them means a block the barber drew himself, edited
-- in the block sheet - these belong to the special day and go when it goes.
ALTER TABLE "AvailabilityException" DROP CONSTRAINT "AvailabilityException_pattern_check";
ALTER TABLE "AvailabilityException"
  ADD CONSTRAINT "AvailabilityException_pattern_check"
  CHECK ("pattern" IS NULL OR "pattern" IN ('single', 'daily', 'continuous', 'weekly', 'special_day'));
