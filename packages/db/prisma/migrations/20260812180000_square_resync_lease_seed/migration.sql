-- Seed the lease row for the half-hourly Square resync job. withLease()
-- acquires by UPDATE-ing an existing row, so a job with no seeded row NEVER
-- runs: the conditional UPDATE matches 0 rows forever, and it is logged only at
-- debug, so the job looks registered and is silently dead. That is exactly how
-- acuity-resync shipped in #99 and stayed dead until 20260730120000.
--
-- expiresAt = now() is already in the past by the first tick, so the first
-- acquire wins. Idempotent via ON CONFLICT; matches
-- 20260730120000_acuity_resync_lease_seed.
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt") VALUES
    ('square-resync', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
