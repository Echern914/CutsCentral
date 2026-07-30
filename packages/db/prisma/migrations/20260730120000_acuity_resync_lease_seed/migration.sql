-- Seed the lease row for the half-hourly Acuity resync job. withLease()
-- acquires by UPDATE-ing an existing row, so a job with no seeded row NEVER
-- runs (the conditional UPDATE matches 0 rows forever, logged only at debug).
-- This job shipped in #99 WITHOUT a seed - it has been silently dead since -
-- and since #147 made synced Acuity Visits block native slots, a stale Acuity
-- mirror is an availability-correctness bug, not just a stale client book.
-- expiresAt = now() is in the past by the first tick, so the first acquire
-- wins. Idempotent via ON CONFLICT; matches 20260712220000_demo_reset_lease_seed.
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt") VALUES
    ('acuity-resync', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
