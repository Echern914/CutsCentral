-- Email is a separate transactional channel from SMS for native bookings, with
-- its own at-most-once idempotency stamps. A customer can receive BOTH a text and
-- an email (like Acuity), and email can go out even while SMS is dark (no 10DLC /
-- no consent) since email only needs a valid address. Nullable, no default, no
-- backfill: existing appointments simply have no email stamp (none was sent).
ALTER TABLE "Appointment"
  ADD COLUMN "confirmationEmailSentAt" TIMESTAMP(3),
  ADD COLUMN "reminderEmailSentAt" TIMESTAMP(3);
