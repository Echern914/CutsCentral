-- Partner program: cash for PEOPLE who bring businesses to ChairBack.
--
-- WHY NEW TABLES. The affiliate tables are a SHOP that applied, earning
-- subscription credit; a partner is a person (Eric, a barber coach) who may own
-- no shop, has a code they can say out loud ("ERIC C"), is created by an admin,
-- and is paid in cash BY HAND. Nothing here moves money.
--   Partner          one person, one code (codeKey unique)
--   PartnerReferral  one row per referred business, ever (referredShopId unique);
--                    the one-time reward is set on it once
--   PartnerCashout   a request to be paid, then marked paid by an admin

-- CreateTable
CREATE TABLE "Partner" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "codeKey" TEXT NOT NULL,
    "userId" TEXT,
    "deactivatedAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerReferral" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "referredShopId" TEXT NOT NULL,
    "codeUsed" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creditedAt" TIMESTAMP(3),
    "creditCents" INTEGER,
    "creditPlan" TEXT,
    "creditInvoiceId" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,

    CONSTRAINT "PartnerReferral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerCashout" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedByUserId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "paidByUserId" TEXT,

    CONSTRAINT "PartnerCashout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Partner_codeKey_key" ON "Partner"("codeKey");

-- CreateIndex
CREATE UNIQUE INDEX "Partner_userId_key" ON "Partner"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerReferral_referredShopId_key" ON "PartnerReferral"("referredShopId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerReferral_creditInvoiceId_key" ON "PartnerReferral"("creditInvoiceId");

-- CreateIndex
CREATE INDEX "PartnerReferral_partnerId_creditedAt_idx" ON "PartnerReferral"("partnerId", "creditedAt");

-- CreateIndex
CREATE INDEX "PartnerCashout_status_requestedAt_idx" ON "PartnerCashout"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "PartnerCashout_partnerId_idx" ON "PartnerCashout"("partnerId");

-- AddForeignKey
ALTER TABLE "PartnerReferral" ADD CONSTRAINT "PartnerReferral_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerCashout" ADD CONSTRAINT "PartnerCashout_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The reward is all-or-nothing: credited rows carry every credit column, and
-- an uncredited row carries none of them.
ALTER TABLE "PartnerReferral"
    ADD CONSTRAINT "PartnerReferral_credit_check" CHECK (
        ("creditedAt" IS NULL AND "creditCents" IS NULL AND "creditPlan" IS NULL AND "creditInvoiceId" IS NULL)
        OR ("creditedAt" IS NOT NULL AND "creditCents" > 0 AND "creditPlan" IS NOT NULL AND "creditInvoiceId" IS NOT NULL)
    );

-- A reversal names a fixed reason, and only a credited reward can be reversed.
ALTER TABLE "PartnerReferral"
    ADD CONSTRAINT "PartnerReferral_reversal_check" CHECK (
        ("reversedAt" IS NULL AND "reversalReason" IS NULL)
        OR ("reversedAt" IS NOT NULL AND "creditedAt" IS NOT NULL
            AND "reversalReason" IN ('invoice_refunded', 'payment_disputed', 'credit_note'))
    );

-- Positive whole cents; PAID exactly when someone paid it. (Which amounts are
-- allowed is policy, in config, so it is not pinned here.)
ALTER TABLE "PartnerCashout"
    ADD CONSTRAINT "PartnerCashout_amount_check" CHECK ("amountCents" > 0),
    ADD CONSTRAINT "PartnerCashout_status_check" CHECK (
        ("status" = 'REQUESTED' AND "paidAt" IS NULL AND "paidByUserId" IS NULL)
        OR ("status" = 'PAID' AND "paidAt" IS NOT NULL AND "paidByUserId" IS NOT NULL)
    );

-- 🔴 DEFAULT-DENY, the TeamLink shape: platform money, no tenant owns it. The
-- tenant role gets nothing (revoked explicitly - under ALTER DEFAULT PRIVILEGES
-- a new table may carry grants), and RLS is enabled + FORCED with no policy.
-- Only the API's owner path reads or writes these.
REVOKE ALL ON "Partner" FROM chairback_app;
ALTER TABLE "Partner" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Partner" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "PartnerReferral" FROM chairback_app;
ALTER TABLE "PartnerReferral" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PartnerReferral" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "PartnerCashout" FROM chairback_app;
ALTER TABLE "PartnerCashout" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PartnerCashout" FORCE ROW LEVEL SECURITY;
