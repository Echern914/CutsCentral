-- Post-service checkout: the barber finishes the cut, opens the appointment and
-- collects the balance -- with the card the customer already saved, with Tap to
-- Pay, or by recording cash. Everything here is additive and backward
-- compatible: no existing row changes meaning, no Stripe id is rewritten, and
-- every deposit, fee and refund already recorded keeps working untouched.

-- ---------------------------------------------------------------------------
-- 1. "Payment" stops being one-row-per-appointment.
-- ---------------------------------------------------------------------------
-- Until now "Payment"."appointmentId" carried a UNIQUE index, so a booking that
-- had already taken a deposit could not also record the balance collected at
-- the chair -- the second insert simply failed. That ceiling is what made a
-- service checkout impossible on any appointment that had paid a deposit.
--
-- The fix is a discriminator plus a NARROWER unique index, so the old
-- invariant is preserved exactly where it still holds.
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "purpose" TEXT NOT NULL DEFAULT 'booking';

-- Every pre-existing row is money taken at BOOKING time (a deposit, a pay-ahead
-- charge or an authorised hold) EXCEPT the card-on-file charges, which only
-- ever exist because a no-show or late-cancellation fee was taken. Labelling
-- them correctly now is what lets the balance maths below ignore fee money.
UPDATE "Payment" SET "purpose" = 'fee' WHERE "mode" = 'card_on_file';

ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_purpose_check";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_purpose_check"
  CHECK ("purpose" IN ('booking', 'fee', 'service_checkout'));

-- Drop the ceiling, keep the lookup fast.
DROP INDEX IF EXISTS "Payment_appointmentId_key";
CREATE INDEX IF NOT EXISTS "Payment_appointmentId_idx" ON "Payment"("appointmentId");

-- The OLD invariant, preserved where it is still true: an appointment may have
-- at most ONE booking payment. A deposit still cannot be taken twice; what is
-- newly possible is a deposit AND a later service checkout side by side.
CREATE UNIQUE INDEX IF NOT EXISTS "Payment_appointmentId_booking_key"
  ON "Payment"("appointmentId") WHERE "purpose" = 'booking';

-- ---------------------------------------------------------------------------
-- 2. Explicit consent to charge a saved card for SERVICES.
-- ---------------------------------------------------------------------------
-- The card-on-file consent collected at booking authorises no-show and
-- late-cancellation FEES. It does not authorise charging the customer for the
-- haircut itself, and reading it as though it did would be taking money on an
-- agreement the customer never made.
--
-- So a service charge needs its own recorded authorisation. These columns are
-- NULL on every existing row, which is exactly the intent: cards saved before
-- this migration are fee-only and stay ineligible. There is no backfill, and
-- there is deliberately no way for a barber to attest to consent on the
-- customer's behalf.
ALTER TABLE "CardOnFile" ADD COLUMN IF NOT EXISTS "serviceChargeConsentVersion" TEXT;
ALTER TABLE "CardOnFile" ADD COLUMN IF NOT EXISTS "serviceChargeConsentAt" TIMESTAMP(3);
-- 'single' = this one appointment. 'series' = every occurrence of the standing
-- appointment the customer agreed to. A series authorisation is its own
-- decision, shown and accepted separately, never inferred from a single one.
ALTER TABLE "CardOnFile" ADD COLUMN IF NOT EXISTS "serviceChargeConsentScope" TEXT;

ALTER TABLE "CardOnFile" DROP CONSTRAINT IF EXISTS "CardOnFile_service_consent_check";
ALTER TABLE "CardOnFile" ADD CONSTRAINT "CardOnFile_service_consent_check"
  CHECK (
    ("serviceChargeConsentScope" IS NULL AND "serviceChargeConsentAt" IS NULL AND "serviceChargeConsentVersion" IS NULL)
    OR ("serviceChargeConsentScope" IN ('single', 'series')
        AND "serviceChargeConsentAt" IS NOT NULL
        AND "serviceChargeConsentVersion" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 3. "CheckoutAttempt" -- the service-checkout ledger.
-- ---------------------------------------------------------------------------
-- One row per attempt to collect a balance, written BEFORE any Stripe call so
-- an attempt whose outcome is unknown is still a fact we hold. This is what
-- makes a double tap, a timeout, a webhook that beats the HTTP response and an
-- app that dies mid-charge all recoverable rather than a second charge.
CREATE TABLE IF NOT EXISTS "CheckoutAttempt" (
  "id"                  TEXT NOT NULL,
  "shopId"              TEXT NOT NULL,
  "appointmentId"       TEXT NOT NULL,
  -- Who is being charged, and who pressed the button. Both are recorded
  -- because "which barber collected this" is an audit question that gets asked.
  "clientId"            TEXT,
  "actorUserId"         TEXT,
  -- The client-supplied idempotency handle for ONE press of Charge. Two taps
  -- send the same one and collapse onto this row; a different one is a
  -- genuinely new attempt and is still refused while this one is live.
  "requestId"           TEXT NOT NULL,
  -- saved_card | tap_to_pay | cash_other
  "method"              TEXT NOT NULL,
  -- Always 'service_checkout' today. Present so a future reason cannot be
  -- confused with this one at the ledger level.
  "reason"              TEXT NOT NULL DEFAULT 'service_checkout',
  "amountCents"         INTEGER NOT NULL,
  "currency"            TEXT NOT NULL DEFAULT 'usd',
  -- Display-safe only. ChairBack stores no card data: these are Stripe's own
  -- words about a method the customer saved, kept so a receipt can say which
  -- card was used without ever holding a PAN.
  "paymentMethodId"     TEXT,
  "cardBrand"           TEXT,
  "cardLast4"           TEXT,
  -- The authorisation this charge was taken under, copied from the card at
  -- charge time so a later consent change cannot rewrite history.
  "consentVersion"      TEXT,
  "consentAt"           TIMESTAMP(3),
  "stripePaymentIntentId" TEXT,
  -- The exact key handed to Stripe. Attempt-scoped, never card-scoped: the
  -- no-show fee helper keys on the CARD, and sharing that key would make a
  -- service charge silently replay the fee's result.
  "idempotencyKey"      TEXT NOT NULL,
  -- pending      : row written, Stripe not yet called.
  -- processing   : Stripe has it; the webhook decides the outcome.
  -- requires_action : the card wants authentication. NOT paid.
  -- succeeded    : settled, by webhook or by an authoritative read.
  -- failed       : declined, definitively.
  -- canceled     : concluded without charging.
  -- ambiguous    : outcome unknown; the reconciler owns it. Blocks everything.
  "state"               TEXT NOT NULL DEFAULT 'pending',
  "failureReason"       TEXT,
  "settledAt"           TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CheckoutAttempt_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CheckoutAttempt" DROP CONSTRAINT IF EXISTS "CheckoutAttempt_state_check";
ALTER TABLE "CheckoutAttempt" ADD CONSTRAINT "CheckoutAttempt_state_check"
  CHECK ("state" IN ('pending', 'processing', 'requires_action', 'succeeded', 'failed', 'canceled', 'ambiguous'));

ALTER TABLE "CheckoutAttempt" DROP CONSTRAINT IF EXISTS "CheckoutAttempt_method_check";
ALTER TABLE "CheckoutAttempt" ADD CONSTRAINT "CheckoutAttempt_method_check"
  CHECK ("method" IN ('saved_card', 'tap_to_pay', 'cash_other'));

-- A repeated tap of one button is the SAME attempt, whatever the network did.
CREATE UNIQUE INDEX IF NOT EXISTS "CheckoutAttempt_appointmentId_requestId_key"
  ON "CheckoutAttempt"("appointmentId", "requestId");

-- 🔴 THE GUARD THAT STOPS TWO COLLECTIONS. At most ONE unresolved attempt may
-- exist per appointment, across ALL methods. A card charge whose outcome is
-- still open therefore blocks Tap to Pay and blocks Cash -- the first attempt
-- must be concluded (settled, refused or cancelled) before another may start.
-- Postgres treats a partial unique index as the whole rule, so this holds under
-- genuine concurrency, not merely in the code path that reads it.
CREATE UNIQUE INDEX IF NOT EXISTS "CheckoutAttempt_appointmentId_live_key"
  ON "CheckoutAttempt"("appointmentId")
  WHERE "state" IN ('pending', 'processing', 'requires_action', 'ambiguous');

CREATE UNIQUE INDEX IF NOT EXISTS "CheckoutAttempt_idempotencyKey_key"
  ON "CheckoutAttempt"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "CheckoutAttempt_shopId_state_idx"
  ON "CheckoutAttempt"("shopId", "state");
CREATE INDEX IF NOT EXISTS "CheckoutAttempt_stripePaymentIntentId_idx"
  ON "CheckoutAttempt"("stripePaymentIntentId");

ALTER TABLE "CheckoutAttempt"
  ADD CONSTRAINT "CheckoutAttempt_shopId_fkey" FOREIGN KEY ("shopId")
  REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CheckoutAttempt"
  ADD CONSTRAINT "CheckoutAttempt_appointmentId_fkey" FOREIGN KEY ("appointmentId")
  REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant table: the same posture as "Payment" and "CardOnFile" -- the app role
-- only ever reaches it inside runWithShop, and never across shops.
GRANT SELECT, INSERT, UPDATE, DELETE ON "CheckoutAttempt" TO chairback_app;
ALTER TABLE "CheckoutAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CheckoutAttempt" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CheckoutAttempt";
CREATE POLICY tenant_isolation ON "CheckoutAttempt"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
