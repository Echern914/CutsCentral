-- Transactional loyalty SMS to clients. When loyaltyTextsEnabled is on, a shop
-- texts a client the moment a completed visit earns punches, or a reward is
-- redeemed ("You earned 1 punch - 4/10 toward a Free Cut"). Off by default:
-- opt-in per shop, and still gated by the client's SMS consent + quiet hours.
-- These sends do NOT count against dailySendCap (they're triggered by a real
-- visit/redemption, not a marketing blast); they're logged in Nudge with
-- kind = 'loyalty', distinct from 'nudge'/'promo'.

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN "loyaltyTextsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- No RLS changes: Shop is owner-scoped (not a tenant table) and the new column
-- is covered by existing policies. Nudge.kind is a free-text column already, so
-- the new 'loyalty' value needs no schema change.
