-- One ledger row per Stripe refund.
--
-- A refund button can be pressed on two devices at once. Both presses name the
-- same Stripe refund (the idempotency key is derived from the payment and what
-- it had refunded before), so the money moves once - but each press used to
-- append its own "succeeded" row, and the audit then read as two refunds.
-- The unique index makes the second row impossible; the writer treats the
-- refusal as "already recorded".
--
-- NULLs are distinct in a Postgres unique index, so the rows a refund leaves
-- with no Stripe id (refused or unclear before Stripe answered) are untouched.
-- Prod had 0 PaymentRefund rows when this was written (2026-10-05), so the
-- index cannot fail to build.
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentRefund_stripeRefundId_key"
  ON "PaymentRefund"("stripeRefundId");
