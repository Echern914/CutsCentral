-- Request-before-booking: the shop toggle + widen the double-booking backstop so
-- a PENDING request holds its exact-start slot. Separate from the ADD VALUE
-- migration because this migration USES 'PENDING' (the index predicate), which
-- Postgres forbids in the same transaction the value was added in.

-- Shop toggle. Off by default so existing shops are unchanged.
ALTER TABLE "Shop" ADD COLUMN "requireBookingApproval" BOOLEAN NOT NULL DEFAULT false;

-- Widen the partial-unique double-booking guard: a PENDING hold must reserve the
-- exact (staff, start) instant against a second PENDING OR a BOOKED at the same
-- start (previously only BOOKED collided). The advisory-lock + overlap SELECT is
-- the primary guard; this index is the last-line backstop under a race.
-- NOTE: the approve path flips the SAME row PENDING->BOOKED in place (never
-- inserts a second row), so a row can't collide with its own hold.
DROP INDEX "Appointment_staff_start_active_uq";
CREATE UNIQUE INDEX "Appointment_staff_start_active_uq"
  ON "Appointment"("staffId", "startsAt")
  WHERE "status" IN ('BOOKED', 'PENDING');
