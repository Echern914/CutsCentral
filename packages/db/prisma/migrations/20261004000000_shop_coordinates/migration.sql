-- Apple Wallet location relevance: an appointment pass can only surface on the
-- lock screen at the SHOP if it carries coordinates. Apple's `locations` array
-- takes lat/lng only, so the address columns cannot stand in for these.
--
-- Both nullable, and null is the expected state for every existing row: no
-- geocoder runs in this codebase, so a shop has coordinates only when someone
-- sets them deliberately. A pass for a shop without them stays valid and keeps
-- time-based relevance.
ALTER TABLE "Shop" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "Shop" ADD COLUMN "longitude" DOUBLE PRECISION;
