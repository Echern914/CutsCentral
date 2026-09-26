-- A last name OR an Instagram handle on every client who signs themselves up
-- (Drick: "people are only signing up with their first names and i cant tell
-- who is who"). Client had no Instagram field, so it gets one; nullable,
-- because barber quick-adds and every existing client have none.
--
-- WHY THREE COLUMNS, not one. Two self-signups reach the Client row later
-- than the form: a waitlist join becomes a Client when the offer is claimed,
-- and "Join shop" at a shop that approves new clients becomes one when the
-- barber accepts. Each keeps the handle where it keeps the name until then.
ALTER TABLE "Client" ADD COLUMN "instagram" TEXT;
ALTER TABLE "WaitlistEntry" ADD COLUMN "instagram" TEXT;
ALTER TABLE "CustomerAccount" ADD COLUMN "instagram" TEXT;
