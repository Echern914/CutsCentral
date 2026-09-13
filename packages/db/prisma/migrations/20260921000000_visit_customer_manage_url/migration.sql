-- The provider's own management page for a SYNCED appointment, plus whether the
-- customer is actually allowed to use it.
--
-- Acuity returns a per-appointment `confirmationPage` alongside
-- `canClientReschedule` / `canClientCancel`. Verified against a live connected
-- account on 2026-09-13: the URL was present on every upcoming appointment
-- while BOTH booleans were false, because that shop has client changes switched
-- off in Acuity. So the URL alone is not permission - the reminder email offers
-- a button only when the matching boolean is true, and keeps the
-- "contact the shop" line otherwise.
--
-- 🔴 customerManageUrl IS A CREDENTIAL: its id[] parameter is a 32-character
-- per-appointment token, and holding it is what authorises changing the
-- booking. Same handling as Appointment.manageToken - never logged, never
-- returned on a dashboard read.
--
-- Additive and backfill-free by design: every column is nullable or defaulted,
-- and the half-hourly acuity-resync job (365-day lookahead) repopulates every
-- upcoming appointment on its next sweep.
ALTER TABLE "Visit" ADD COLUMN "customerManageUrl" TEXT;
ALTER TABLE "Visit" ADD COLUMN "customerCanReschedule" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Visit" ADD COLUMN "customerCanCancel" BOOLEAN NOT NULL DEFAULT false;
