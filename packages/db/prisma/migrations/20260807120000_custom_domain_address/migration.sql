-- Custom domain (redirect model: the domain 301s to /s/[slug]) + street
-- address for LocalBusiness structured data. All nullable - no backfill.
ALTER TABLE "Shop" ADD COLUMN "customDomain" TEXT;
ALTER TABLE "Shop" ADD COLUMN "customDomainVerifiedAt" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN "addressStreet" TEXT;
ALTER TABLE "Shop" ADD COLUMN "addressCity" TEXT;
ALTER TABLE "Shop" ADD COLUMN "addressRegion" TEXT;
ALTER TABLE "Shop" ADD COLUMN "addressPostal" TEXT;

-- One shop per domain; doubles as the resolve-by-host lookup index.
CREATE UNIQUE INDEX "Shop_customDomain_key" ON "Shop"("customDomain");
