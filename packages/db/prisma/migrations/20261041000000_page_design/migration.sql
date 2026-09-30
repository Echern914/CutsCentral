-- The shop's public page DESIGN - the whole-page layout (config PAGE_DESIGNS).
-- "classic" is the page every shop had before designs existed. It is the
-- default, so no existing page changes until its owner picks another design.
-- Validated against the config keys at the API boundary, like `theme`; an
-- unknown value renders classic (pageDesignFor).
ALTER TABLE "Shop" ADD COLUMN "pageDesign" TEXT NOT NULL DEFAULT 'classic';
