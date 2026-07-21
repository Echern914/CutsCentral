-- Calendar color-coding for services. Stores one of the SERVICE_COLORS keys
-- (packages/config/src/constants.ts) - the KEY, not a hex, so the palette can be
-- re-tuned without a data migration. Nullable, no default: every existing
-- service is simply uncolored (renders with the default subtle border). Purely
-- cosmetic - drives the accent stripe on the barber's appointment blocks.
ALTER TABLE "Service" ADD COLUMN "color" TEXT;
