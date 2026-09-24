-- Booth rent between a team's shop and an independent member (TeamLink):
-- an amount per week or month on the link, and the payments the owner records.
--
-- WHY A NEW TABLE. Nothing records money paid between two businesses - a
-- shop's Payment rows are its CLIENTS' payments.

-- CreateEnum
CREATE TYPE "RentPeriod" AS ENUM ('WEEKLY', 'MONTHLY');

-- AlterTable
ALTER TABLE "TeamLink" ADD COLUMN     "rentCents" INTEGER,
ADD COLUMN     "rentPeriod" "RentPeriod";

-- CreateTable
CREATE TABLE "BoothRentPayment" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paidOn" DATE NOT NULL,
    "method" TEXT NOT NULL,
    "note" TEXT,
    "recordedById" TEXT NOT NULL,
    "clientRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoothRentPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BoothRentPayment_linkId_paidOn_idx" ON "BoothRentPayment"("linkId", "paidOn");

-- CreateIndex
CREATE UNIQUE INDEX "BoothRentPayment_linkId_clientRef_key" ON "BoothRentPayment"("linkId", "clientRef");

-- AddForeignKey
ALTER TABLE "BoothRentPayment" ADD CONSTRAINT "BoothRentPayment_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "TeamLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Whole positive cents; a known payment method; rent set all-or-nothing.
ALTER TABLE "BoothRentPayment"
    ADD CONSTRAINT "BoothRentPayment_amount_check" CHECK ("amountCents" > 0 AND "amountCents" <= 10000000),
    ADD CONSTRAINT "BoothRentPayment_method_check" CHECK ("method" IN ('cash', 'zelle', 'cashapp', 'venmo', 'card', 'other'));
ALTER TABLE "TeamLink"
    ADD CONSTRAINT "TeamLink_rent_check" CHECK (
        ("rentCents" IS NULL AND "rentPeriod" IS NULL)
        OR ("rentCents" > 0 AND "rentCents" <= 10000000 AND "rentPeriod" IS NOT NULL)
    );

-- Default-deny, like TeamLink: a payment belongs to two shops, so only the
-- API's owner path touches it.
REVOKE ALL ON "BoothRentPayment" FROM chairback_app;
ALTER TABLE "BoothRentPayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BoothRentPayment" FORCE ROW LEVEL SECURITY;
