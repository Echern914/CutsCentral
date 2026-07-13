-- Client check-in ("On my way"). Nullable sub-state of BOOKED - deliberately NOT
-- new AppointmentStatus enum values (an enum ADD VALUE needs its own isolated
-- migration and the lifecycle statuses stay pure). All columns nullable /
-- defaulted so every existing row is untouched.
--   checkInStatus: null | 'en_route' | 'arrived'
--   checkedInAt:   stamped on the FIRST "On my way" tap, never moved after
--   etaMinutes:    optional ETA chip (5/10/15)
--   runningLate:   the "Running late" chip
ALTER TABLE "Appointment"
  ADD COLUMN "checkInStatus" TEXT,
  ADD COLUMN "checkedInAt"   TIMESTAMP(3),
  ADD COLUMN "etaMinutes"    INTEGER,
  ADD COLUMN "runningLate"   BOOLEAN NOT NULL DEFAULT false;
