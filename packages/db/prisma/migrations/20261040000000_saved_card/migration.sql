-- A client's card, kept by one shop for their future appointments.
--
-- WHY. A barber: "save a universal card so appointments go straight through
-- after they select time". A card-on-file shop asked for the card on every
-- booking and let every card go after its visit; a returning client typed it
-- again each time, and some abandoned the booking at that step.
--
-- SavedCard is the card the client chose to keep (one live per client per
-- shop). Each appointment booked with it still gets an ordinary CardOnFile row
-- - now pointing at the SavedCard - so the existing charge rules apply to it
-- unchanged. SavedCardDevice / SavedCardCode are how the booking page proves
-- the person using it is the person who saved it: a device token, or a
-- one-time text code on a new phone. Never a typed phone number alone.
--
-- Additive: new tables, and nullable columns on CardOnFile.

CREATE TABLE "SavedCard" (
  "id"                    TEXT NOT NULL,
  "shopId"                TEXT NOT NULL,
  "clientId"              TEXT NOT NULL,
  "stripeCustomerId"      TEXT NOT NULL,
  "stripePaymentMethodId" TEXT NOT NULL,
  "brand"                 TEXT,
  "last4"                 TEXT,
  "expMonth"              INTEGER,
  "expYear"               INTEGER,
  "consentVersion"        TEXT NOT NULL,
  "consentAt"             TIMESTAMP(3) NOT NULL,
  "sourceAppointmentId"   TEXT,
  "removedAt"             TIMESTAMP(3),
  "detachedAt"            TIMESTAMP(3),
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavedCard_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SavedCard_shopId_clientId_idx" ON "SavedCard"("shopId", "clientId");
-- 🔴 ONE LIVE SAVED CARD PER CLIENT PER SHOP. Saving another replaces it (the
-- old row is stamped removedAt first, in the same transaction).
CREATE UNIQUE INDEX "SavedCard_one_live_per_client"
  ON "SavedCard"("shopId", "clientId") WHERE "removedAt" IS NULL;
ALTER TABLE "SavedCard"
  ADD CONSTRAINT "SavedCard_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedCard"
  ADD CONSTRAINT "SavedCard_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SavedCardDevice" (
  "id"          TEXT NOT NULL,
  "shopId"      TEXT NOT NULL,
  "savedCardId" TEXT NOT NULL,
  "tokenHash"   TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt"  TIMESTAMP(3),
  "revokedAt"   TIMESTAMP(3),
  CONSTRAINT "SavedCardDevice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SavedCardDevice_tokenHash_key" ON "SavedCardDevice"("tokenHash");
CREATE INDEX "SavedCardDevice_savedCardId_idx" ON "SavedCardDevice"("savedCardId");
ALTER TABLE "SavedCardDevice"
  ADD CONSTRAINT "SavedCardDevice_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedCardDevice"
  ADD CONSTRAINT "SavedCardDevice_savedCardId_fkey" FOREIGN KEY ("savedCardId") REFERENCES "SavedCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SavedCardCode" (
  "id"          TEXT NOT NULL,
  "shopId"      TEXT NOT NULL,
  "savedCardId" TEXT NOT NULL,
  "codeHash"    TEXT NOT NULL,
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "consumedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SavedCardCode_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SavedCardCode_savedCardId_createdAt_idx" ON "SavedCardCode"("savedCardId", "createdAt");
ALTER TABLE "SavedCardCode"
  ADD CONSTRAINT "SavedCardCode_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedCardCode"
  ADD CONSTRAINT "SavedCardCode_savedCardId_fkey" FOREIGN KEY ("savedCardId") REFERENCES "SavedCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CardOnFile" ADD COLUMN "savedCardId" TEXT;
ALTER TABLE "CardOnFile" ADD COLUMN "saveCardConsentVersion" TEXT;
ALTER TABLE "CardOnFile" ADD COLUMN "saveCardConsentAt" TIMESTAMP(3);
CREATE INDEX "CardOnFile_savedCardId_idx" ON "CardOnFile"("savedCardId");
ALTER TABLE "CardOnFile"
  ADD CONSTRAINT "CardOnFile_savedCardId_fkey" FOREIGN KEY ("savedCardId") REFERENCES "SavedCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- The consent to keep the card is a version AND a time, or nothing.
ALTER TABLE "CardOnFile" ADD CONSTRAINT "CardOnFile_save_card_consent_check"
  CHECK (("saveCardConsentVersion" IS NULL) = ("saveCardConsentAt" IS NULL));

-- Tenant isolation, as for CardOnFile.
GRANT SELECT, INSERT, UPDATE, DELETE ON "SavedCard" TO chairback_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "SavedCardDevice" TO chairback_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "SavedCardCode" TO chairback_app;
ALTER TABLE "SavedCard" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SavedCard" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SavedCard"
  USING ("shopId" = current_shop_id()) WITH CHECK ("shopId" = current_shop_id());
ALTER TABLE "SavedCardDevice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SavedCardDevice" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SavedCardDevice"
  USING ("shopId" = current_shop_id()) WITH CHECK ("shopId" = current_shop_id());
ALTER TABLE "SavedCardCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SavedCardCode" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SavedCardCode"
  USING ("shopId" = current_shop_id()) WITH CHECK ("shopId" = current_shop_id());
