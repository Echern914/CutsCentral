-- Acquisition attribution captured at signup. `acquisition` is the raw
-- first-touch marketing blob (utm_*, gclid, fbclid, landingPath) the web
-- middleware records into a first-party cookie when a visitor lands from an ad;
-- `referralCode` is pulled into its own indexed column because affiliate payouts
-- query signups by code. Both nullable with no default so every existing user
-- is simply "organic/pre-tracking" and nothing changes for them.
ALTER TABLE "User" ADD COLUMN "acquisition" JSONB;
ALTER TABLE "User" ADD COLUMN "referralCode" TEXT;

CREATE INDEX "User_referralCode_idx" ON "User"("referralCode");
