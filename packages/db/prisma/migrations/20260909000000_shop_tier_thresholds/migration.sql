-- What it takes to reach each loyalty tier, per shop. NULL = the platform
-- defaults (Bronze 1, Silver 6, Gold 12), which is every existing shop, so
-- this deploy changes nothing anyone can see.
--
-- Shape is {"BRONZE":n,"SILVER":n,"GOLD":n} with strictly increasing whole
-- numbers, validated in the API (config/constants.ts validateTierThresholds)
-- and re-validated on read, because a Json column holds whatever was last
-- written to it.
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "tierThresholds" JSONB;
