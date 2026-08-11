-- Tap to Pay on iPhone (Stripe Terminal), phase 1: the server groundwork.
--
-- A Terminal Location is REQUIRED before any reader can connect, Tap to Pay
-- included. One per shop, created lazily and cached here so a connection-token
-- request never makes a duplicate Location on Stripe.
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "stripeTerminalLocationId" TEXT;

-- A card-present charge is a third kind of Payment row, alongside the
-- pay-ahead and hold flavours. It is ONLY ever a Payment snapshot - never a
-- shop setting, because a shop does not "run in terminal mode", it collects at
-- the chair on the cuts where it wants to.
--
-- ADD VALUE IF NOT EXISTS is transaction-safe from PG12 on (Prisma wraps each
-- migration in one); the guard also makes a re-run a no-op.
ALTER TYPE "PaymentsMode" ADD VALUE IF NOT EXISTS 'terminal';
