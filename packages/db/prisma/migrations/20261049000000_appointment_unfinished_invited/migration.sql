-- "Didn't finish booking": when the barber emailed a client whose time was
-- taken to pick another time. The at-most-once claim for that email: set
-- before the send, cleared if the send fails. Nullable, additive.
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "unfinishedInvitedAt" TIMESTAMP(3);
