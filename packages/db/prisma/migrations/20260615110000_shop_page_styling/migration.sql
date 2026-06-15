-- Per-shop public-page styling + a richer gallery.
--   galleryItems : gallery photos WITH optional captions ([{ "url", "caption"? }])
--   fontKey      : typography pairing (PAGE_FONTS key)
--   layoutStyle  : corner/button shape (LAYOUT_STYLES key)
--   sectionOrder : ordered/visible sections (PAGE_SECTIONS keys); [] = default order
-- galleryUrls is kept (not dropped) for one release as a rollback safety net.

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN "galleryItems" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "Shop" ADD COLUMN "fontKey" TEXT;
ALTER TABLE "Shop" ADD COLUMN "layoutStyle" TEXT;
ALTER TABLE "Shop" ADD COLUMN "sectionOrder" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill galleryItems from the legacy galleryUrls: each URL becomes { "url": <url> }
-- (no caption). Only touch rows that actually have legacy URLs.
UPDATE "Shop"
SET "galleryItems" = (
  SELECT COALESCE(jsonb_agg(jsonb_build_object('url', u)), '[]'::jsonb)
  FROM unnest("galleryUrls") AS u
)
WHERE array_length("galleryUrls", 1) IS NOT NULL;
