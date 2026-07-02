-- Forgot-password tokens + trial-expiry reminder plumbing. Both features are
-- DARK until RESEND_API_KEY/EMAIL_FROM are set (see messaging/email.ts), so
-- this migration changes no runtime behavior on its own.

-- CreateTable: one-shot password reset tokens. Only the sha256 of the emailed
-- token is stored (tokenHash), so a DB leak can't reset anyone's password.
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- AddForeignKey: cascade so deleting a user can never strand live reset tokens.
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: non-tenant table (keyed to User, the global login identity). Enable RLS
-- with NO policy so the Supabase data API roles (anon/authenticated) are denied,
-- while the `postgres` owner the app connects as BYPASSES RLS and keeps full
-- access. Matches the 20260609000000 non-tenant lockdown pattern. FORCE is
-- intentionally NOT used (owner keeps access).
ALTER TABLE "PasswordResetToken" ENABLE ROW LEVEL SECURITY;

-- Shop: highest trial-reminder stage already emailed (0 = none, 1 = week-left,
-- 2 = ends-tomorrow, 3 = ended). Default 0 backfills every existing shop as
-- "never reminded"; the sweep's time thresholds decide what (if anything) each
-- shop gets next. See engines/trialReminder.ts.
ALTER TABLE "Shop" ADD COLUMN "trialReminderStage" INTEGER NOT NULL DEFAULT 0;

-- Seed the lease row for the new trial-reminders cron job. withLease() acquires
-- by UPDATE-ing an existing row, so a job with no seeded row would never run
-- (the conditional UPDATE matches 0 rows forever). expiresAt defaults to now()
-- (in the past by the first tick) so the first acquire wins. Idempotent via
-- ON CONFLICT. Matches the seed pattern in 20260629213222_job_lease.
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt") VALUES
    ('trial-reminders', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
