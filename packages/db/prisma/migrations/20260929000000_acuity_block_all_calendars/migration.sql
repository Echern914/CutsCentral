-- One chair, several Acuity calendars.
--
-- An Acuity block is calendar-scoped. A single barber whose account splits his
-- work across "Haircut" / "Retwists" / "After hours" calendars is one human
-- with one chair, so a block on one of them leaves the rest sellable at that
-- same hour - the exact double-booking the outbound mirror exists to stop.
-- Staff.acuityExtraCalendarIds lists the other calendars that one chair
-- occupies; the mirror then writes one block per calendar, one row each.
--
-- Additive: the column defaults to empty, so every shop mapping one chair to
-- one calendar behaves exactly as before.
ALTER TABLE "Staff"
  ADD COLUMN IF NOT EXISTS "acuityExtraCalendarIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- THE IDEMPOTENCY BACKSTOP, WIDENED BY ONE COLUMN.
--
-- It was "at most one live block per appointment", which is precisely what has
-- to change: an appointment now owns one live block PER CALENDAR. The rule it
-- still enforces is the one that matters - a re-dispatch, a retried backfill or
-- two concurrent writers can never mint a second block for the same
-- (appointment, calendar). RELEASING/RELEASED/FAILED stay outside the index, so
-- a reschedule can still hold the old block in RELEASING while its replacement
-- goes PENDING.
DROP INDEX IF EXISTS "AcuityOutboundBlock_live_per_appointment";
CREATE UNIQUE INDEX IF NOT EXISTS "AcuityOutboundBlock_live_per_appointment_calendar"
  ON "AcuityOutboundBlock"("appointmentId", "acuityCalendarId")
  WHERE "state" IN ('PENDING', 'ACTIVE', 'UNKNOWN');
