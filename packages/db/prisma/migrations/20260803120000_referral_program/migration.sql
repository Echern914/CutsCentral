-- Referral program: "refer a barber, you both get a month free".
--
-- Shop.referralCode is the code a shop HANDS OUT. It is deliberately separate
-- from User.referralCode (the code a user ARRIVED with, added in
-- 20260721030000_user_acquisition_attribution) - one is outbound, one inbound.
-- Nullable because it is minted lazily the first time a shop opens the referrals
-- page, so no backfill is needed and existing shops are untouched.
ALTER TABLE "Shop" ADD COLUMN "referralCode" TEXT;
CREATE UNIQUE INDEX "Shop_referralCode_key" ON "Shop"("referralCode");

-- PENDING  = friend signed up, hasn't paid; no reward exists yet.
-- REWARDED = friend's first invoice cleared and the referrer's month was granted.
-- VOID     = disqualified, never payable (today: self-referral).
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'REWARDED', 'VOID');

-- One row per referred shop. The reward fires on the friend's first SUCCESSFUL
-- PAYMENT rather than on signup, so farming it with throwaway accounts costs
-- more than the free month is worth.
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "referrerShopId" TEXT NOT NULL,
    "referredShopId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "qualifiedAt" TIMESTAMP(3),
    "rewardedAt" TIMESTAMP(3),
    "rewardKind" TEXT,
    "rewardAmountCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- A shop can only ever be referred once. This is the structural guard that stops
-- a second signup (or a webhook replay creating a duplicate row) from paying out
-- twice for the same referred shop.
CREATE UNIQUE INDEX "Referral_referredShopId_key" ON "Referral"("referredShopId");

-- "How many has this shop driven, and which are still pending?"
CREATE INDEX "Referral_referrerShopId_status_idx" ON "Referral"("referrerShopId", "status");

ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerShopId_fkey"
  FOREIGN KEY ("referrerShopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referredShopId_fkey"
  FOREIGN KEY ("referredShopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS defense-in-depth. Unlike the other tenant tables, Referral has no single
-- "shopId": a row concerns TWO shops, so the policy admits a row when the
-- current shop is either party. A referrer must be able to read the referrals
-- they drove, and the referred shop must be able to see it was referred.
--
-- The reward grant itself runs from the Stripe webhook, which is not
-- shop-scoped and therefore connects as the DB owner (RLS applies only inside
-- runWithShop, which does SET LOCAL ROLE chairback_app). That path is
-- unaffected by this policy - deliberately, since granting a reward has to
-- touch the referrer's shop while acting on the referred shop's payment.
GRANT SELECT, INSERT, UPDATE, DELETE ON "Referral" TO chairback_app;

ALTER TABLE "Referral" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Referral" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "Referral";
CREATE POLICY tenant_isolation ON "Referral"
  USING ("referrerShopId" = current_shop_id() OR "referredShopId" = current_shop_id())
  WITH CHECK ("referrerShopId" = current_shop_id() OR "referredShopId" = current_shop_id());
