-- A shop can let clients tip online after a visit (Payments -> Tips).
--
-- OFF by default: no shop's clients are asked for anything until its owner
-- turns this on, and turning it on is checked against a ready Stripe account.
-- Separate from "tipPolicy", which is wording only and needs no Stripe at all.
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "onlineTipsEnabled" BOOLEAN NOT NULL DEFAULT false;
