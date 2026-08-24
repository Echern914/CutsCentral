-- Seed the lease row for the waitlist offer-expiry sweep. withLease() acquires
-- by UPDATE-ing an existing row, so a job with no seeded row NEVER runs: the
-- conditional UPDATE matches 0 rows forever and the job is silently dead -
-- exactly how acuity-resync shipped in #99. scheduler.leaseSeed.test.ts
-- enforces this file's existence structurally.
--
-- expiresAt = now() is already in the past by the first tick, so the first
-- acquire wins. Idempotent via ON CONFLICT; matches
-- 20260812180000_square_resync_lease_seed.
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt") VALUES
    ('waitlist-offer-expiry', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
