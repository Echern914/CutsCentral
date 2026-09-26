-- A tier the owner or a manager raises a client to BY HAND ("the barber should
-- be able to press it and move them up a tier on their own").
--
-- UP ONLY, AND IT STICKS. The floor is never a replacement for the earned
-- tier: every writer of Client.loyaltyTier stamps the HIGHER of the two, so the
-- shop's rules can still lift the client past it but can never drop them below
-- it. null = automatic, which is every existing row - so adding these columns
-- changes no client's tier.
--
-- Additive and nullable only: no default, no backfill, no index (nothing
-- filters on the floor; the stored loyaltyTier stays the column that is read).
ALTER TABLE "Client" ADD COLUMN "loyaltyTierFloor" "LoyaltyTier",
ADD COLUMN "loyaltyTierFloorSetAt" TIMESTAMP(3);
