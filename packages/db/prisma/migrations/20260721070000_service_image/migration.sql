-- Per-service photo for the public booking card (a menu-style thumbnail, like a
-- "VIP Package" shot). Stores an https(s) URL in the public storage bucket -
-- same boundary as the shop/staff branding images. Nullable, no default: every
-- existing service is simply photoless (renders text-only, unchanged). Purely
-- cosmetic - richens the customer-facing service menu, nothing server-critical.
ALTER TABLE "Service" ADD COLUMN "imageUrl" TEXT;
