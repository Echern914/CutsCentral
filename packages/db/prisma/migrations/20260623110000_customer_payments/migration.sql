-- Customer payments via Stripe Connect (per-barber). Ships DARK: paymentsMode
-- defaults to 'off' and every other column is defaulted/nullable, so existing
-- shops are byte-for-byte unchanged until a barber connects + turns payments on.

-- CreateEnum
CREATE TYPE "PaymentsMode" AS ENUM ('off', 'ahead', 'hold');

-- AlterTable: per-shop Connect + payment config (all defaulted/nullable)
ALTER TABLE "Shop" ADD COLUMN "stripeConnectAccountId" TEXT;
ALTER TABLE "Shop" ADD COLUMN "connectChargesEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Shop" ADD COLUMN "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Shop" ADD COLUMN "paymentsMode" "PaymentsMode" NOT NULL DEFAULT 'off';
ALTER TABLE "Shop" ADD COLUMN "platformFeeBps" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Shop" ADD COLUMN "cancelWindowHours" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Shop" ADD COLUMN "cancelFeeBps" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex (unique connected-account id)
CREATE UNIQUE INDEX "Shop_stripeConnectAccountId_key" ON "Shop"("stripeConnectAccountId");

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT NOT NULL,
    "stripeChargeId" TEXT,
    "stripeConnectAccountId" TEXT NOT NULL,
    "mode" "PaymentsMode" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "applicationFeeAmount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'requires_payment_method',
    "capturedAmount" INTEGER,
    "refundedAmount" INTEGER NOT NULL DEFAULT 0,
    "authorizedAt" TIMESTAMP(3),
    "holdExpiresAt" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3),
    "lastWebhookEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_appointmentId_key" ON "Payment"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_stripePaymentIntentId_key" ON "Payment"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "Payment_shopId_status_idx" ON "Payment"("shopId", "status");

-- CreateIndex
CREATE INDEX "Payment_status_holdExpiresAt_idx" ON "Payment"("status", "holdExpiresAt");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS defense-in-depth: same tenant-isolation pattern as the other tenant tables.
-- The dashboard path (forShop -> SET ROLE chairback_app) is enforced; the public
-- booking-payment insert + the Connect webhook write run as the connection owner
-- (no SET ROLE) and bypass FORCE RLS, exactly like the appointment/booking writes.
GRANT SELECT, INSERT, UPDATE, DELETE ON "Payment" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Payment']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING ("shopId" = current_shop_id())
        WITH CHECK ("shopId" = current_shop_id());
    $f$, t);
  END LOOP;
END
$$;
