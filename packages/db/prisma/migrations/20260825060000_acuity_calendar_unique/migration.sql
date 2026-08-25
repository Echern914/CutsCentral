-- ONE CALENDAR, ONE CHAIR.
--
-- Two staff mapped to the same Acuity calendar would mirror both barbers'
-- bookings onto one calendar: barber B's 2pm would blank barber A's 2pm in
-- Acuity even though A is free, and a release for either would fight the
-- other. Partial (WHERE NOT NULL) so any number of chairs may stay unmapped -
-- unmapped is the default state and must not collide.
CREATE UNIQUE INDEX IF NOT EXISTS "Staff_shopId_acuityCalendarId_key"
  ON "Staff"("shopId", "acuityCalendarId")
  WHERE "acuityCalendarId" IS NOT NULL;
