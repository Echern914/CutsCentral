-- Per-service available-hours restriction, mirroring the priceOverrides /
-- durationOverrides JSON idiom: a map of shop-local weekday ("0".."6") to an
-- array of {s,e} minute-from-midnight windows (e exclusive), e.g.
-- {"1": [{"s":600,"e":840}]} = "Mondays this service is only bookable 10:00-14:00".
-- Tri-state by key presence: weekday absent = unrestricted (staff hours as-is),
-- present+non-empty = allowed only within those windows (intersected with staff
-- availability), present+[] = not offered that weekday. Empty {} (the default
-- every existing service gets) = unrestricted every day, so existing services
-- behave exactly as before. See engines/slots.ts + engines/pricing.ts.
ALTER TABLE "Service" ADD COLUMN "hoursWindows" JSONB NOT NULL DEFAULT '{}';
