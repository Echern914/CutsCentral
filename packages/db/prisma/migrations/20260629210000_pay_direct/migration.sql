-- Fee-free "pay the barber directly" handles (Zelle / Venmo / Cash App). These
-- are DISPLAY-ONLY: ChairBack never processes, verifies, or reconciles them
-- (Zelle/Venmo/Cash App have no third-party platform API). Independent of the
-- Stripe paymentsMode flow. All additive + defaulted/nullable, so existing shops
-- are unchanged (pay-direct off until the barber turns it on).
ALTER TABLE "Shop" ADD COLUMN "payDirectEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Shop" ADD COLUMN "payDirectZelle" TEXT;
ALTER TABLE "Shop" ADD COLUMN "payDirectVenmo" TEXT;
ALTER TABLE "Shop" ADD COLUMN "payDirectCashApp" TEXT;
ALTER TABLE "Shop" ADD COLUMN "payDirectNote" TEXT;
