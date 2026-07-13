-- Rewards become opt-IN. New shops start with rewards OFF (some barbers just
-- want a booking app); every EXISTING shop is backfilled ON so nothing changes
-- for them. The flag is a pure gate - no ledger data is touched by toggling.
ALTER TABLE "Shop" ADD COLUMN "rewardsEnabled" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Shop" SET "rewardsEnabled" = true;
