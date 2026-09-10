-- Booking questions, scoped per service. Additive: one array column with an
-- empty default, which is exactly today's behaviour (asked on every service).
--
-- A mobile mechanic asks for a street address on the jobs he drives to and
-- nothing on the ones done in his own bay. Asking every customer for an
-- address that is not needed is how a booking form starts losing people.
ALTER TABLE "BookingQuestion"
  ADD COLUMN "serviceIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
