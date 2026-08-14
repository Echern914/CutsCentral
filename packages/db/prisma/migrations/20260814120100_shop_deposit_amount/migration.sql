-- The deposit a shop takes at booking, in CENTS. Nullable with no default: null
-- means "not chosen yet", which is the correct reading for every existing shop
-- and lets the settings UI suggest $20 without silently committing anyone to it.
--
-- Capped at the service price when the charge is built, so a $20 deposit can
-- never overcharge a $15 line-up.
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "depositAmountCents" INTEGER;
