-- Barber/manager devices in PushSubscription. Until now every row belonged to
-- a CLIENT (customer rewards page / native app). The iOS dashboard app also
-- registers the OWNER's device for business events (new appointment request),
-- keyed by the new nullable userId. clientId becomes nullable: a row belongs
-- to EITHER a client (customer transport) OR a user (barber transport) - the
-- API stamps exactly one of the two server-side, never from the request body.
--
-- Additive + widening only, so the previously deployed API keeps working
-- through the migration window (it never writes userId and always sets
-- clientId). RLS is untouched: the table keeps its FORCE RLS shopId policy;
-- user-keyed reads/writes go through runAsOwner exactly like the public
-- client-row writes already do.
ALTER TABLE "PushSubscription" ALTER COLUMN "clientId" DROP NOT NULL;

ALTER TABLE "PushSubscription" ADD COLUMN "userId" TEXT;

ALTER TABLE "PushSubscription"
  ADD CONSTRAINT "PushSubscription_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");
