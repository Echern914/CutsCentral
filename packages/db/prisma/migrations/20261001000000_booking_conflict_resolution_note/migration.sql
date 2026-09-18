-- The manager conflict inbox: a short note saying what was done about it.
--
-- EXPAND ONLY, and the smallest possible expansion: one nullable TEXT column on
-- a table that is empty in production today. A running old API neither reads
-- nor writes it.
--
-- The prefix is a SEQUENCE NUMBER, not a date claim (see CLAUDE.md): it only
-- has to sort after every migration that already exists, and 20260930000000 is
-- the current last one.
ALTER TABLE "BookingConflict" ADD COLUMN IF NOT EXISTS "resolutionNote" TEXT;
