/* Never dispatch an EXPIRED AMBIGUOUS attempt, and reserve attempts atomically.

   The 24h idempotency window was only ever checked INSIDE the ambiguous
   handler - which runs AFTER the request. So an intent whose first attempt
   died ambiguously could sit for a day and then be sent again with a key the
   provider no longer honours: if the first attempt had in fact been accepted
   and the second succeeded, the customer got the same cancellation email
   twice. The check has to happen BEFORE the call, which means the fact that
   the last attempt was ambiguous has to be on disk.

   "claimToken" makes the attempt reservation a compare-and-set. A worker whose
   claim aged out and was taken over cannot wake up and spend another provider
   attempt on a row it no longer holds, and the attempt NUMBER now comes from
   an atomic UPDATE ... RETURNING rather than from a value read minutes
   earlier, so two workers cannot both think they are attempt 3. */

ALTER TABLE "EmailIntent"
  ADD COLUMN IF NOT EXISTS "lastAttemptAmbiguous" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "claimToken" TEXT;
