-- CreateEnum
CREATE TYPE "CadencePreference" AS ENUM ('WEEKLY', 'BIWEEKLY', 'EVERY_3_WEEKS', 'MONTHLY', 'OCCASIONAL');

-- CreateEnum
CREATE TYPE "LoyaltyTier" AS ENUM ('BRONZE', 'SILVER', 'GOLD');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "loyaltyTier" "LoyaltyTier",
ADD COLUMN     "preferredCadence" "CadencePreference";

