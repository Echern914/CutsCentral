-- Promotions: shop-designed offers (percent/amount off, free add-on, extra
-- punches) with live windows, walk-in redemption tracking, and SMS blasts that
-- ride the existing Nudge audit trail (kind='promo', linked to the promotion
-- for per-promo attribution).

-- CreateEnum
CREATE TYPE "PromotionKind" AS ENUM ('PERCENT_OFF', 'AMOUNT_OFF', 'FREE_ADDON', 'EXTRA_PUNCHES');

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kind" "PromotionKind" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "code" TEXT,
    "percentOff" INTEGER,
    "amountOff" DECIMAL(10,2),
    "extraPunches" INTEGER,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionRedemption" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionRedemption_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Nudge" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'nudge';
ALTER TABLE "Nudge" ADD COLUMN "promotionId" TEXT;

-- CreateIndex
CREATE INDEX "Promotion_shopId_active_startsAt_idx" ON "Promotion"("shopId", "active", "startsAt");

-- CreateIndex
CREATE INDEX "PromotionRedemption_shopId_promotionId_idx" ON "PromotionRedemption"("shopId", "promotionId");

-- CreateIndex
CREATE INDEX "PromotionRedemption_shopId_clientId_idx" ON "PromotionRedemption"("shopId", "clientId");

-- CreateIndex
CREATE INDEX "Nudge_promotionId_idx" ON "Nudge"("promotionId");

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Nudge" ADD CONSTRAINT "Nudge_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS defense-in-depth: same tenant-isolation pattern as the other tenant tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON "Promotion", "PromotionRedemption" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Promotion', 'PromotionRedemption']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING ("shopId" = current_shop_id())
        WITH CHECK ("shopId" = current_shop_id());
    $f$, t);
  END LOOP;
END
$$;
