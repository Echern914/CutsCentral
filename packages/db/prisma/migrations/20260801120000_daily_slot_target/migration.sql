-- Display-only daily slot targets, powering the calendar day gauge ("12 / 16").
-- Deliberately NOT caps: nothing in engines/slots.ts reads these, so booking past
-- a target is allowed and simply reads 13/12. ServiceGroup.maxPerDay remains the
-- one enforced daily ceiling.
--
-- Nullable with no default, so every existing row keeps "no target" and the
-- calendar renders exactly as it does today until a barber sets one.
ALTER TABLE "ServiceGroup" ADD COLUMN "dailyTarget" INTEGER;
ALTER TABLE "Service" ADD COLUMN "dailyTarget" INTEGER;
