-- Hidden services (a barber: "a service that is NOT visible to clients and
-- only me ... tap the eye icon to turn it off"). config/serviceVisibility.ts.
--
-- The prefix is a SEQUENCE NUMBER, not a date (see CLAUDE.md): 20261034000000
-- and 20261035000000 are taken by PRs open alongside this one; this sorts
-- after both.
--
-- EXPAND ONLY. Every existing service gets 'public', which is exactly what it
-- is today. A running old API neither reads nor writes the column (and would
-- keep listing a hidden service publicly - so this column must ship with the
-- code that reads it, which Railway's migrate-then-deploy does).
ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "visibility" TEXT NOT NULL DEFAULT 'public';

-- A string, not a boolean, so a later "only clients I pick" is a new value
-- rather than a second column - but only known values.
ALTER TABLE "Service" DROP CONSTRAINT IF EXISTS "Service_visibility_known";
ALTER TABLE "Service" ADD CONSTRAINT "Service_visibility_known"
  CHECK ("visibility" IN ('public', 'hidden'));
