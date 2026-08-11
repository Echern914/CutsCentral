-- Chair-side checkout: the barber collects at the end of the cut and records
-- what was actually taken. This is money COLLECTED IN PERSON, on top of any
-- Stripe pre-payment (the Payment row) - the two never overlap, so a shop's
-- real revenue for an appointment is Payment + paidAmount.
--
-- paidMethod: 'cash' | 'direct' (Zelle/Venmo/CashApp) | 'card' | 'other'.
-- All nullable, no defaults: null means "never checked out at the chair",
-- which is the correct reading for every row that already exists.
ALTER TABLE "Appointment"
  ADD COLUMN IF NOT EXISTS "paidAmount" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "paidMethod" TEXT,
  ADD COLUMN IF NOT EXISTS "paidAt"     TIMESTAMP(3);
