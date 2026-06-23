-- Per-weekday service price overrides. A service keeps its base `price`; this
-- JSON map holds only the weekdays that differ (e.g. {"0": 55} for a Sunday
-- premium). The customer is shown the effective price for the date they pick.
-- Backward-compatible: existing rows default to an empty map (= base price every
-- day), so nothing changes until a barber sets an override.

ALTER TABLE "Service" ADD COLUMN "priceOverrides" JSONB NOT NULL DEFAULT '{}';
