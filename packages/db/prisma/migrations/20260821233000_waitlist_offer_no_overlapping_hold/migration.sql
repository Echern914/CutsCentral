-- One live hold per physical slot -- properly this time.
--
-- Phase A shipped a partial unique index on ("shopId","staffId","startsAt")
-- WHERE status = 'OFFERED'. That stops two holds starting at the same INSTANT.
-- It does not stop 10:00-11:00 and 10:30-11:30 on the same barber, which is
-- the same double-booking as far as the barber and both customers are
-- concerned. Calling that index a physical-slot guarantee was too strong.
--
-- The appointment guard has the identical shape and closes the gap in
-- application code: pg_advisory_xact_lock on the barber's calendar, then an
-- overlap SELECT inside the same transaction (bookingWrite.ts). That is sound,
-- but it holds only while every writer remembers to take the lock first.
-- Offers get written by the matcher, the release path and the expiry worker,
-- so here the range itself is the constraint and no caller can forget it.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Subsumed: identical starts always overlap, because "endsAt" > "startsAt" is
-- already a CHECK, so every range is non-empty. Dropping it leaves ONE rule
-- and one error code (23P01) for the claim path to handle.
DROP INDEX IF EXISTS "WaitlistOffer_one_active_per_slot";

-- tsrange is half-open, '[)', so back-to-back holds are still allowed: a
-- 10:00-11:00 hold does not block one starting at 11:00. Blocking those would
-- lose the shop real bookings.
ALTER TABLE "WaitlistOffer" ADD CONSTRAINT "WaitlistOffer_no_overlapping_hold"
  EXCLUDE USING gist (
    "shopId"  WITH =,
    "staffId" WITH =,
    tsrange("startsAt", "endsAt") WITH &&
  ) WHERE ("status" = 'OFFERED');
