-- Barber's note ON THE BOOKING, distinct from Client.notes.
--
-- Client.notes is who the person is ("allergic to the green cape", "prefers
-- Tuesdays") and follows them forever. This is about THIS appointment ("moved
-- from Saturday, comping the beard") and must not leak into the client's
-- permanent record - which is exactly what would happen if the edit form wrote
-- appointment context into the client row.
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "notes" TEXT;
