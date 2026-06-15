-- First-run welcome tour: a nullable timestamp on User, stamped the first time
-- the barber finishes or skips the dashboard welcome carousel. null = never
-- seen, so the tour auto-opens exactly once. No RLS change: User is a non-tenant
-- table (already locked down by the earlier non-tenant RLS migration).

-- AlterTable
ALTER TABLE "User" ADD COLUMN "welcomeSeenAt" TIMESTAMP(3);
