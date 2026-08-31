-- Which Connect door a shop came through: "express" (ChairBack created the
-- account) or "standard" (the barber linked a Stripe account they already had).
--
-- Additive and non-destructive. Nothing about taking payments branches on this
-- column: charges are destination charges with on_behalf_of for BOTH types.
-- It exists so the dashboard can describe the account honestly, and so
-- "Finish setup" is only offered where a Stripe-hosted form actually exists.
ALTER TABLE "Shop" ADD COLUMN "stripeConnectAccountType" TEXT;

-- Backfill is safe and exact, not a guess: the OAuth/standard door does not
-- exist before this migration, so EVERY account already connected was created
-- by billing/connect.ts `accounts.create({ type: "express" })`.
--
-- Scoped to rows that actually have an account. A shop with no
-- stripeConnectAccountId has come through no door at all and must stay NULL —
-- stamping it would claim a connection it does not have.
UPDATE "Shop"
   SET "stripeConnectAccountType" = 'express'
 WHERE "stripeConnectAccountId" IS NOT NULL;
