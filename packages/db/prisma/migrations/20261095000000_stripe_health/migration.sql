-- Stripe health: what Stripe still needs from a connected shop (billing/stripeHealth.ts).
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "connectRequirementsDue" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "connectRequirementsDueBy" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "connectDisabledReason" TEXT;
