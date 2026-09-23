-- Append-only ledger of refunds a shop issues from ChairBack against a
-- post-service checkout payment. Additive only.
--
-- WHY IT EXISTS. Before this, the only way to refund a Tap to Pay or saved-card
-- checkout was the Stripe dashboard - and on a DESTINATION charge the barber's
-- own dashboard shows only a copy of the payment. Refunding that copy reverses
-- the transfer (the barber gives the money back to the platform) and refunds
-- the customer NOTHING. That happened on the first live Tap to Pay payment
-- (2026-09-23): Stripe said "refunded" on the barber's side while the
-- customer's card still carried the charge. The refund now happens in
-- ChairBack, on the platform charge, and this table records who did it.

CREATE TABLE "PaymentRefund" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "reverseTransfer" BOOLEAN NOT NULL,
    "stripeRefundId" TEXT,
    "outcome" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentRefund_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PaymentRefund_shopId_appointmentId_createdAt_idx"
  ON "PaymentRefund"("shopId", "appointmentId", "createdAt");
CREATE INDEX "PaymentRefund_paymentId_idx" ON "PaymentRefund"("paymentId");
ALTER TABLE "PaymentRefund"
  ADD CONSTRAINT "PaymentRefund_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/* A refund is a positive number of cents, and its outcome is one of four. */
ALTER TABLE "PaymentRefund"
  ADD CONSTRAINT "PaymentRefund_amount_positive" CHECK ("amountCents" > 0);
ALTER TABLE "PaymentRefund"
  ADD CONSTRAINT "PaymentRefund_outcome_check"
  CHECK ("outcome" IN ('succeeded', 'pending', 'failed', 'ambiguous'));
/* A barber's note is a sentence, not a document. */
ALTER TABLE "PaymentRefund"
  ADD CONSTRAINT "PaymentRefund_note_length" CHECK ("note" IS NULL OR char_length("note") <= 200);

/* Append-only for EVERYONE, the connection owner included - same rule as
   AppointmentPriceChange. DELETE still works so a shop cascade succeeds. */
CREATE OR REPLACE FUNCTION payment_refund_immutable() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'PaymentRefund is append-only: UPDATE is not permitted'
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_refund_no_update ON "PaymentRefund";
CREATE TRIGGER payment_refund_no_update
  BEFORE UPDATE ON "PaymentRefund"
  FOR EACH ROW EXECUTE FUNCTION payment_refund_immutable();

/* Tenant isolation, like every other shop table. The app role may read and
   append its own shop's rows and nothing else. */
GRANT SELECT, INSERT ON "PaymentRefund" TO chairback_app;
REVOKE UPDATE, DELETE ON "PaymentRefund" FROM chairback_app;
ALTER TABLE "PaymentRefund" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentRefund" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PaymentRefund";
CREATE POLICY tenant_isolation ON "PaymentRefund"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
