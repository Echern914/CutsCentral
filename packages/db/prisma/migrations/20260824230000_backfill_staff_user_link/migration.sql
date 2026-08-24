-- Backfill Staff.userId from the team seat that already holds each chair.
--
-- Staff.userId is READ by every barber-facing alert path — recipientForAppointment()
-- in services/barberNotify.ts, notifyBarberBookingEvent() in services/appointmentNotify.ts,
-- the cancel/reschedule notifications in routes/booking.public.ts, and the next-up /
-- day-ahead sweeps in engines/barberReminders.ts — all of which resolve the recipient as
-- `staff.userId ?? shop.ownerId`.
--
-- It was never WRITTEN. The staff POST/PATCH schema never carried the column, and
-- 20260731120000_team_members backfilled ShopMember only. So the fallback fired every
-- time: in a multi-chair shop, every "someone just booked", every cancellation and every
-- reminder went to the OWNER, using the owner's notification preferences, and an employee
-- barber was never notified about their own chair.
--
-- From this migration on the invariant is maintained on write, in one place
-- (apps/api/src/services/staffUserLink.ts), off the seat->chair link that already exists
-- on ShopMember.staffId (unique: one person per chair). This statement makes the existing
-- rows agree with it.
--
-- Idempotent and conservative: only fills rows that are still NULL, so it can be re-run
-- and can never overwrite a link the application has already set. NO schema change — the
-- column has existed since 20260622110000_native_booking.
UPDATE "Staff" s
SET "userId" = m."userId"
FROM "ShopMember" m
WHERE m."staffId" = s."id"
  AND m."shopId" = s."shopId"
  AND s."userId" IS NULL;
