-- Client rewards page (/r/[magicToken]) content control.
--   rewardsWelcome  : optional short greeting shown atop the client's rewards
--                     page; NULL = no custom line.
--   rewardsSections : visible REWARDS_SECTIONS keys; [] = show all (the default).
--                     The punch balance + SMS consent card are always shown and
--                     are NOT part of this list.
-- The rewards page already inherits the shop's theme/font/shape; these tailor
-- what it says and which optional blocks appear.

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN "rewardsWelcome" TEXT;
ALTER TABLE "Shop" ADD COLUMN "rewardsSections" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
