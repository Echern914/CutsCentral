-- Shared-store backing for express-rate-limit so per-IP / per-session limits
-- hold ACROSS API replicas (an in-memory MemoryStore fragments them once we run
-- more than one replica, and resets on every deploy). One row per limiter key;
-- the increment-or-reset is a single atomic INSERT ... ON CONFLICT, pooler-safe
-- exactly like job_lease. See apps/api/src/middleware/pgRateStore.ts.
CREATE TABLE "rate_limit_counter" (
    "key" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limit_counter_pkey" PRIMARY KEY ("key")
);

-- For the periodic stale-row sweep (delete rows whose window expired long ago).
CREATE INDEX "rate_limit_counter_expiresAt_idx" ON "rate_limit_counter"("expiresAt");

-- RLS: non-tenant utility table. Enable RLS with NO policy so the Supabase data
-- API roles are denied while the `postgres` owner the app connects as BYPASSES
-- RLS and keeps full access. Matches the job_lease / non-tenant lockdown pattern.
-- FORCE is intentionally NOT used (owner keeps access).
ALTER TABLE "rate_limit_counter" ENABLE ROW LEVEL SECURITY;

-- Seed the lease row for the stale-counter sweep cron (withLease needs the row
-- to exist to race on it). expiresAt defaults to now() (past by the first tick).
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt") VALUES
    ('rate-limit-sweep', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
