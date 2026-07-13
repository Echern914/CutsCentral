-- Seed lease rows for the AI-receptionist cron jobs. withLease() acquires by
-- UPDATE-ing an existing row, so a job with no seeded row would never run (the
-- conditional UPDATE matches 0 rows forever). expiresAt defaults to now() (in the
-- past by the first tick) so the first acquire wins. Idempotent via ON CONFLICT.
-- Matches the seed pattern in 20260629221500_winback_lease_seed.
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt") VALUES
    ('receptionist-conversation-close', '', now(), now()),
    ('receptionist-hold-sweep', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
