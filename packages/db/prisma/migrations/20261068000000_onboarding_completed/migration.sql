-- FIRST-TIME SETUP: when a shop finished onboarding, or its owner skipped it.
--
-- NULL means a new shop still setting up: signing in on the web resumes setup
-- at its next step. Every shop that exists today is marked complete with its
-- own createdAt, so no established shop is ever sent back through setup.
--
-- Additive: one nullable column, filled once for existing rows.
ALTER TABLE "Shop" ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3);
UPDATE "Shop" SET "onboardingCompletedAt" = "createdAt" WHERE "onboardingCompletedAt" IS NULL;
