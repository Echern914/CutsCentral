-- Custom tier rules, per shop: visits and/or money, each over its own window,
-- all or any. NULL = the shop's tierThresholds (lifetime visits) decide, which
-- is every existing shop, so this deploy changes nothing anyone can see.
--
-- Shape is {"version":1,"tiers":{...}}, validated in the API
-- (config/tierRules.ts validateTierRules) and re-validated on read, because a
-- Json column holds whatever was last written to it.
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "tierRules" JSONB;

/* Lease seed for the daily tier recompute.

   🔴 A scheduled job whose name has no job_lease row NEVER runs - withLease
   cannot acquire a lease that does not exist. scheduler.leaseSeed.test.ts
   asserts this quoted literal exists in a committed migration: 'tier-recompute'. */
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt")
VALUES ('tier-recompute', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
