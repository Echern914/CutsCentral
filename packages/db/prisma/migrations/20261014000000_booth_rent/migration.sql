-- Booth rent between a team's shop and an independent member (TeamLink): a
-- manual tracker. The owner sets the rent (with an explicit start date),
-- changes or stops it, and records payments as they come in.
--
-- WHY NEW TABLES. Nothing records money owed between two businesses - a
-- shop's Payment rows are its CLIENTS' payments. And rent needs its HISTORY,
-- not just today's amount: without when it started and what it used to be,
-- a missed week is invisible and a rate change would re-price the past.
--
--   BoothRentRate    one row per start / change / stop; never edited.
--   BoothRentPayment what the owner recorded as received.
--
-- A mistake in either is VOIDED (kept in the history, no longer counted),
-- never deleted.
--
-- The balance is computed on read (services/boothRent.ts); no job writes it.

-- CreateEnum
CREATE TYPE "RentPeriod" AS ENUM ('WEEKLY', 'MONTHLY');

-- CreateTable
CREATE TABLE "BoothRentRate" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "amountCents" INTEGER,
    "period" "RentPeriod",
    "startsOn" DATE NOT NULL,
    "createdById" TEXT NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoothRentRate_pkey" PRIMARY KEY ("id")
);

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
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoothRentPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BoothRentRate_linkId_startsOn_idx" ON "BoothRentRate"("linkId", "startsOn");

-- CreateIndex
CREATE INDEX "BoothRentPayment_linkId_paidOn_idx" ON "BoothRentPayment"("linkId", "paidOn");

-- CreateIndex
CREATE UNIQUE INDEX "BoothRentPayment_linkId_clientRef_key" ON "BoothRentPayment"("linkId", "clientRef");

-- AddForeignKey
ALTER TABLE "BoothRentRate" ADD CONSTRAINT "BoothRentRate_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "TeamLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoothRentPayment" ADD CONSTRAINT "BoothRentPayment_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "TeamLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A rate is a whole positive amount with a period, or a stop (both null).
ALTER TABLE "BoothRentRate"
    ADD CONSTRAINT "BoothRentRate_amount_check" CHECK (
        ("amountCents" IS NULL AND "period" IS NULL)
        OR ("amountCents" > 0 AND "amountCents" <= 10000000 AND "period" IS NOT NULL)
    );

-- Whole positive cents; a known payment method.
ALTER TABLE "BoothRentPayment"
    ADD CONSTRAINT "BoothRentPayment_amount_check" CHECK ("amountCents" > 0 AND "amountCents" <= 10000000),
    ADD CONSTRAINT "BoothRentPayment_method_check" CHECK ("method" IN ('cash', 'zelle', 'cashapp', 'venmo', 'card', 'other'));

-- Default-deny, like TeamLink: both belong to two shops, so only the API's
-- owner path touches them.
REVOKE ALL ON "BoothRentRate" FROM chairback_app;
ALTER TABLE "BoothRentRate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BoothRentRate" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "BoothRentPayment" FROM chairback_app;
ALTER TABLE "BoothRentPayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BoothRentPayment" FORCE ROW LEVEL SECURITY;
