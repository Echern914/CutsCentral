-- CreateTable
CREATE TABLE "job_lease" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_lease_pkey" PRIMARY KEY ("name")
);

-- RLS: non-tenant utility table. Enable RLS with NO policy so the Supabase data
-- API roles (anon/authenticated) are denied, while the `postgres` owner the app
-- connects as BYPASSES RLS and keeps full access. Matches the 20260609000000
-- non-tenant lockdown pattern. FORCE is intentionally NOT used (owner keeps access).
ALTER TABLE "job_lease" ENABLE ROW LEVEL SECURITY;

-- Seed one row per scheduled job. expiresAt defaults to now() (already in the
-- past by the first tick), so the first `UPDATE ... WHERE expiresAt < now()` has
-- a row to win. holder='' marks "never held". Idempotent via ON CONFLICT.
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt") VALUES
    ('nudge-sweep', '', now(), now()),
    ('appointment-reminders', '', now(), now()),
    ('promote-visits', '', now(), now()),
    ('promote-appointments', '', now(), now()),
    ('attribution', '', now(), now()),
    ('square-token-refresh', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
