-- Public shop page: per-shop slug + theme + hero/bio/hours/instagram/gallery.
-- Every barber gets their own mini-site at /s/[slug]; the slug is backfilled
-- from the shop name (deduped with a numeric suffix).

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN "slug" TEXT;
ALTER TABLE "Shop" ADD COLUMN "publicPageEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Shop" ADD COLUMN "theme" TEXT NOT NULL DEFAULT 'classic';
ALTER TABLE "Shop" ADD COLUMN "bio" TEXT;
ALTER TABLE "Shop" ADD COLUMN "heroImageUrl" TEXT;
ALTER TABLE "Shop" ADD COLUMN "instagramHandle" TEXT;
ALTER TABLE "Shop" ADD COLUMN "hoursText" TEXT;
ALTER TABLE "Shop" ADD COLUMN "galleryUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill slugs from names: lowercase, non-alphanumerics collapsed to '-',
-- empty names fall back to 'shop', duplicates get -2, -3, ... by age.
UPDATE "Shop" s
SET "slug" = sub.slug
FROM (
  SELECT
    id,
    base || CASE WHEN rn = 1 THEN '' ELSE '-' || rn::text END AS slug
  FROM (
    SELECT
      id,
      COALESCE(
        NULLIF(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), ''),
        'shop'
      ) AS base,
      row_number() OVER (
        PARTITION BY COALESCE(
          NULLIF(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), ''),
          'shop'
        )
        ORDER BY "createdAt"
      ) AS rn
    FROM "Shop"
  ) t
) sub
WHERE s.id = sub.id AND s."slug" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Shop_slug_key" ON "Shop"("slug");
