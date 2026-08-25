-- SQUARE OUTBOUND FOUNDATION (S1)
--
-- Everything here is additive and inert: no shop can be anything but OFF until
-- a manager explicitly arms it, and nothing in this migration causes a single
-- Square API call. It exists so that PR S2's mirroring has somewhere to aim.
--
-- Idempotent by construction (IF NOT EXISTS everywhere) so a double-run - the
-- deploy gate re-applies migrations on every boot - is a no-op rather than an
-- error.

-- The mode. A separate type from "AcuityOutboundMode" on purpose: Square's
-- prerequisites are strictly larger (location + team member + service variation
-- + granted write scopes + a seller plan that permits seller-level writes), and
-- one shared type is an invitation to one shared gate.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SquareOutboundMode') THEN
    CREATE TYPE "SquareOutboundMode" AS ENUM ('OFF', 'OBSERVE', 'ENFORCE');
  END IF;
END
$$;

ALTER TABLE "Shop"
  ADD COLUMN IF NOT EXISTS "squareOutboundMode" "SquareOutboundMode" NOT NULL DEFAULT 'OFF';

--  SquareConnection: authorization generation, granted scopes, capability,
--  and the explicitly chosen outbound location.

ALTER TABLE "SquareConnection"
  -- Bumped on every completed OAuth callback. A mapping stamped with a
  -- generation other than the current one was made against an authorization
  -- that no longer exists, and is therefore stale. An integer, not a timestamp:
  -- the inbound callback's UPDATE branch never touched connectedAt, so a
  -- reconnected row still carries its original timestamp and a timestamp
  -- comparison would call such a mapping fresh.
  ADD COLUMN IF NOT EXISTS "connectionGeneration" INTEGER NOT NULL DEFAULT 1,
  -- What Square GRANTED, read back from RetrieveTokenStatus. Never the scope
  -- string we requested: a seller can decline, and every token minted before
  -- outbound existed carries read scopes only.
  ADD COLUMN IF NOT EXISTS "grantedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "scopesCheckedAt" TIMESTAMP(3),
  -- RetrieveBusinessBookingProfile. support_seller_level_writes is false below
  -- Appointments Plus; discovering that at call time means discovering it on a
  -- real customer's booking.
  ADD COLUMN IF NOT EXISTS "sellerLevelWrites" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "bookingEnabled" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "capabilityCheckedAt" TIMESTAMP(3),
  -- The location outbound writes into. Deliberately NOT "squareLocationId",
  -- which was chosen by "first ACTIVE location" at connect time - acceptable for
  -- reading a single-location seller, never good enough for writing into a
  -- multi-location seller's calendar.
  ADD COLUMN IF NOT EXISTS "outboundLocationId" TEXT,
  ADD COLUMN IF NOT EXISTS "outboundLocationName" TEXT,
  ADD COLUMN IF NOT EXISTS "outboundLocationGeneration" INTEGER,
  ADD COLUMN IF NOT EXISTS "outboundLocationSelectedAt" TIMESTAMP(3);

--  Staff -> Square team member

ALTER TABLE "Staff"
  ADD COLUMN IF NOT EXISTS "squareTeamMemberId" TEXT,
  ADD COLUMN IF NOT EXISTS "squareTeamMemberMappedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "squareTeamMemberMappedGeneration" INTEGER;

-- ONE TEAM MEMBER, ONE CHAIR.
--
-- Two chairs pointing at the same Square team member would mirror both barbers'
-- work onto one person's Square day: chair B's 2pm would make chair A's 2pm look
-- taken to the seller, and (where Square rejects overlaps) chair A's mirror
-- would start failing for a conflict that does not exist. Partial so any number
-- of chairs may stay unmapped - unmapped is the default and must not collide.
CREATE UNIQUE INDEX IF NOT EXISTS "Staff_shopId_squareTeamMemberId_key"
  ON "Staff"("shopId", "squareTeamMemberId")
  WHERE "squareTeamMemberId" IS NOT NULL;

--  Service -> Square service variation

-- The version travels WITH the id: Square rejects a booking whose
-- service_variation_version is behind the catalog, so a mapping without a
-- version is not a usable mapping. Stored as TEXT because the value is an int64
-- that is only ever echoed back to Square - never arithmetic - and a BIGINT
-- would turn an Express JSON response into a throw.
ALTER TABLE "Service"
  ADD COLUMN IF NOT EXISTS "squareServiceVariationId" TEXT,
  ADD COLUMN IF NOT EXISTS "squareServiceVariationVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "squareServiceVariationMappedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "squareServiceVariationMappedGeneration" INTEGER;

-- NOTE: deliberately NO unique index on (shopId, squareServiceVariationId).
-- Two ChairBack services legitimately share one Square variation ("Haircut" and
-- "Haircut + beard trim" priced as one Square service), and nothing downstream
-- resolves BACK from a variation to a service - a mirrored booking is linked by
-- its own row's appointmentId, not by looking its variation up. Uniqueness here
-- would block real shops to protect an inference nobody makes. The team-member
-- index above is different: that one aims a booking at a human being.

--  RLS: nothing new to grant.
--
-- Shop, Staff and Service already carry tenant policies keyed on shopId, and a
-- new COLUMN on an existing table inherits them. SquareConnection is a secrets
-- table (ENABLE, no FORCE/policy/GRANT - reachable only by the owner role, like
-- AcuityConnection), which is why the outbound settings that gate real writes
-- live on it rather than on Shop.
