-- OFFERS & CODES: a shop's own discount codes and personal offers, applied to
-- a booking's price (engines/offers.ts).
--
-- Additive. A switch on Shop (off for every shop), a permission list on
-- ShopMember (empty for every seat), and two new tables. Nothing existing
-- changes shape; Promotion and PromotionRedemption are untouched.

ALTER TABLE "Shop" ADD COLUMN "offersEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopMember" ADD COLUMN "offerServiceIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE TYPE "OfferKind" AS ENUM ('AMOUNT_OFF', 'PERCENT_OFF', 'FREE_SERVICE');

CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "OfferKind" NOT NULL,
    "amountOffCents" INTEGER,
    "percentOffBps" INTEGER,
    "freeServiceId" TEXT,
    "serviceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "staffIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "clientId" TEXT,
    "maxUses" INTEGER,
    "maxUsesPerClient" INTEGER,
    "endsAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id"),
    -- The same shape normalizePromoCode() produces: a code that could not be
    -- typed back in can never be stored.
    CONSTRAINT "Offer_code_check" CHECK ("code" ~ '^[A-Z0-9-]{3,24}$'),
    -- Exactly the value its kind needs, inside isValidDiscount()'s range.
    CONSTRAINT "Offer_value_check" CHECK (
      ("kind" = 'AMOUNT_OFF' AND "amountOffCents" BETWEEN 1 AND 1000000 AND "percentOffBps" IS NULL AND "freeServiceId" IS NULL)
      OR ("kind" = 'PERCENT_OFF' AND "percentOffBps" BETWEEN 1 AND 10000 AND "amountOffCents" IS NULL AND "freeServiceId" IS NULL)
      OR ("kind" = 'FREE_SERVICE' AND "freeServiceId" IS NOT NULL AND "amountOffCents" IS NULL AND "percentOffBps" IS NULL)
    ),
    CONSTRAINT "Offer_limits_check" CHECK (
      ("maxUses" IS NULL OR "maxUses" >= 1) AND ("maxUsesPerClient" IS NULL OR "maxUsesPerClient" >= 1)
    )
);

-- One code per shop. Another shop may use the same letters: codes are looked
-- up by (shop, code) and never across shops.
CREATE UNIQUE INDEX "Offer_shopId_code_key" ON "Offer"("shopId", "code");
CREATE INDEX "Offer_shopId_clientId_idx" ON "Offer"("shopId", "clientId");

ALTER TABLE "Offer" ADD CONSTRAINT "Offer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OfferRedemption" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "clientId" TEXT,
    "listPriceCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL,
    "via" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfferRedemption_pkey" PRIMARY KEY ("id"),
    -- Never more off than the visit cost, never a negative price.
    CONSTRAINT "OfferRedemption_amounts_check" CHECK ("listPriceCents" >= 0 AND "discountCents" BETWEEN 0 AND "listPriceCents"),
    CONSTRAINT "OfferRedemption_via_check" CHECK ("via" IN ('dashboard', 'online'))
);

-- ONE offer per booking: a retried or racing claim for the same booking finds
-- the first one's row instead of writing a second.
CREATE UNIQUE INDEX "OfferRedemption_appointmentId_key" ON "OfferRedemption"("appointmentId");
CREATE INDEX "OfferRedemption_shopId_offerId_idx" ON "OfferRedemption"("shopId", "offerId");
CREATE INDEX "OfferRedemption_shopId_clientId_idx" ON "OfferRedemption"("shopId", "clientId");

ALTER TABLE "OfferRedemption" ADD CONSTRAINT "OfferRedemption_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OfferRedemption" ADD CONSTRAINT "OfferRedemption_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- CASCADE, not RESTRICT: the demo shop's nightly reset hard-deletes appointments.
ALTER TABLE "OfferRedemption" ADD CONSTRAINT "OfferRedemption_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/* Both are the shop's: tenant isolation, like Promotion. */
GRANT SELECT, INSERT, UPDATE, DELETE ON "Offer" TO chairback_app;
ALTER TABLE "Offer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Offer" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Offer";
CREATE POLICY tenant_isolation ON "Offer"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "OfferRedemption" TO chairback_app;
ALTER TABLE "OfferRedemption" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OfferRedemption" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "OfferRedemption";
CREATE POLICY tenant_isolation ON "OfferRedemption"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
