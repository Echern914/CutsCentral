-- Stripe billing + industry vertical. Additive-only: the previously deployed
-- API never reads these columns, so prod keeps working through the deploy
-- window (same playbook as 20260611020000_shop_page).

ALTER TABLE "Shop"
  ADD COLUMN "industry" TEXT NOT NULL DEFAULT 'barber',
  ADD COLUMN "stripeCustomerId" TEXT,
  ADD COLUMN "stripeSubscriptionId" TEXT,
  ADD COLUMN "subscriptionStatus" TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN "trialEndsAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Shop_stripeCustomerId_key" ON "Shop"("stripeCustomerId");

-- Every shop that existed before billing shipped gets a fresh full trial
-- starting now, so flipping Stripe on can never instantly lock anyone out.
UPDATE "Shop" SET "trialEndsAt" = now() + interval '14 days' WHERE "trialEndsAt" IS NULL;
