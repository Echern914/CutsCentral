-- Card on file: keep a customer's card at booking without charging it, so a
-- pay-at-the-chair shop is protected against no-shows without asking a
-- stranger to prepay. Nothing is charged unless the shop turns the fee switch
-- on AND marks the appointment (PR 2). Everything here is additive.

-- A fourth shop-level mode. `hold` and `terminal` already exist; `card_on_file`
-- differs from `hold` in that NO amount is authorised - a SetupIntent saves the
-- card and any later charge is a fresh off-session PaymentIntent.
ALTER TYPE "PaymentsMode" ADD VALUE IF NOT EXISTS 'card_on_file';

-- The master switch Eric asked for: "card on file doesn't get charged unless
-- the barber is set and it's on them". Default OFF so turning the mode on is
-- never, by itself, a decision to charge anybody.
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "chargeCardOnFileFees" BOOLEAN NOT NULL DEFAULT false;

-- One saved card per appointment. Separate from "Payment" on purpose: a
-- Payment row is money that moved (or is moving); this is a credential we are
-- holding on the customer's behalf, and "Payment.appointmentId" is unique - a
-- later no-show charge needs its own Payment row against the same appointment.
CREATE TABLE IF NOT EXISTS "CardOnFile" (
  "id"                    TEXT NOT NULL,
  "shopId"                TEXT NOT NULL,
  "appointmentId"         TEXT NOT NULL,
  -- The PLATFORM Customer this card is attached to (destination charges live
  -- on the platform account). One per booking; never shared across shops.
  "stripeCustomerId"      TEXT NOT NULL,
  "stripeSetupIntentId"   TEXT NOT NULL,
  -- Filled in once the SetupIntent succeeds.
  "stripePaymentMethodId" TEXT,
  -- Out-of-PCI-scope display facts, straight from Stripe, never synthesised.
  "brand"                 TEXT,
  "last4"                 TEXT,
  -- pending: SetupIntent created, customer still on the card screen.
  -- saved:   card attached; the appointment was promoted to BOOKED.
  -- released: appointment completed/cancelled without a fee; card detached.
  -- charged: PR 2 charged it (the Payment row carries the money facts).
  -- failed:  PR 2 tried and the card refused; the barber was told.
  "status"                TEXT NOT NULL DEFAULT 'pending',
  "savedAt"               TIMESTAMP(3),
  "releasedAt"            TIMESTAMP(3),
  "lastWebhookEventId"    TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CardOnFile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CardOnFile_appointmentId_key" ON "CardOnFile"("appointmentId");
CREATE UNIQUE INDEX IF NOT EXISTS "CardOnFile_stripeSetupIntentId_key" ON "CardOnFile"("stripeSetupIntentId");
CREATE INDEX IF NOT EXISTS "CardOnFile_shopId_status_idx" ON "CardOnFile"("shopId", "status");

ALTER TABLE "CardOnFile"
  ADD CONSTRAINT "CardOnFile_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CardOnFile"
  ADD CONSTRAINT "CardOnFile_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Pin the vocabulary: a status nobody handles must fail loudly at write time,
-- not surface as a card that is never released.
ALTER TABLE "CardOnFile" DROP CONSTRAINT IF EXISTS "CardOnFile_status_check";
ALTER TABLE "CardOnFile" ADD CONSTRAINT "CardOnFile_status_check"
  CHECK ("status" IN ('pending', 'saved', 'released', 'charged', 'failed'));

-- Tenant table: same posture as "Payment" (the app role reads and writes it,
-- always inside runWithShop, never across shops).
GRANT SELECT, INSERT, UPDATE, DELETE ON "CardOnFile" TO chairback_app;
ALTER TABLE "CardOnFile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CardOnFile" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CardOnFile";
CREATE POLICY tenant_isolation ON "CardOnFile"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
