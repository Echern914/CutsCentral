-- Per-weekday service DURATION overrides, mirroring the priceOverrides JSON
-- from the day-pricing feature: {"0".."6" (shop-local weekday) -> minutes}.
-- Empty {} (the default every existing service gets) = base durationMin on
-- every day, so existing services behave exactly as before.
ALTER TABLE "Service" ADD COLUMN "durationOverrides" JSONB NOT NULL DEFAULT '{}';
