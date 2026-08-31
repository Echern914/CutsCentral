/* Cancellation-email idempotency stamp.

   Additive and nullable: every existing appointment reads as "no cancellation
   email sent", which is true. The column is CLAIMED before dispatch
   (UPDATE ... WHERE "cancellationEmailSentAt" IS NULL) so concurrent cancels
   and post-failure retries send exactly one message. */
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "cancellationEmailSentAt" TIMESTAMP(3);
