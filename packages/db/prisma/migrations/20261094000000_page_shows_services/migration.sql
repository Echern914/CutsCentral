/* ------------------------------------------------------------------ *
 * A shop can take its services menu off its public page
 * (Shop.pageShowsServices; on for everyone by default).
 * ------------------------------------------------------------------ */

ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "pageShowsServices" BOOLEAN NOT NULL DEFAULT true;

/* The Directions button on the public page (Shop.pageShowsDirections): OFF
 * for every shop, existing ones included, until the barber turns it on. */
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "pageShowsDirections" BOOLEAN NOT NULL DEFAULT false;
