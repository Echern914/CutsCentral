/* ONE TAP, ONE REDEMPTION.

   A redemption whose answer was lost (no signal, a gateway 502 after the API
   had already written it) and was tapped again redeemed a SECOND reward for a
   client with punches for two: nothing could tell the retry from a new
   redemption. The dashboard now mints one id per Redeem and re-sends it on a
   retry; the API answers the retry from the row the first try wrote.

   1. "requestId": nullable. Every existing row and every non-redemption entry
      stays NULL, and many NULLs are allowed under the unique below.
   2. Unique per shop, so a retry can never write a second row for one tap.
   3. The append-only trigger now freezes it too: it is the identity a retry
      is matched by, so it may never be re-pointed at another entry. The
      function is otherwise byte-for-byte the one from
      20260923000000_punch_ledger_append_only, with one line added.

   Additive: ADD COLUMN fires no row trigger and writes no existing row; the
   table-level grants and the tenant policy cover the new column. Reversible
   by dropping the index and column and restoring the previous function. */

ALTER TABLE "PunchLedger" ADD COLUMN "requestId" TEXT;

ALTER TABLE "PunchLedger"
  ADD CONSTRAINT "PunchLedger_requestId_check"
  CHECK ("requestId" IS NULL OR char_length("requestId") BETWEEN 16 AND 64);

CREATE UNIQUE INDEX "PunchLedger_shopId_requestId_key" ON "PunchLedger"("shopId", "requestId");

CREATE OR REPLACE FUNCTION punch_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('chairback.ledger_teardown', true) = 'on' THEN
      RETURN OLD;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Client" WHERE "id" = OLD."clientId")
       OR NOT EXISTS (SELECT 1 FROM "Shop" WHERE "id" = OLD."shopId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'PunchLedger is append-only: write an offsetting entry instead of deleting %', OLD."id"
      USING ERRCODE = '23000';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."shopId" IS DISTINCT FROM OLD."shopId"
     OR NEW."punchesEarned" IS DISTINCT FROM OLD."punchesEarned"
     OR NEW."punchesRedeemed" IS DISTINCT FROM OLD."punchesRedeemed"
     OR NEW."runningBalance" IS DISTINCT FROM OLD."runningBalance"
     OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."cardTypeId" IS DISTINCT FROM OLD."cardTypeId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
     OR (NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId" AND NEW."actorUserId" IS NOT NULL)
     OR (NEW."visitId" IS DISTINCT FROM OLD."visitId" AND NEW."visitId" IS NOT NULL)
     OR (NEW."rewardId" IS DISTINCT FROM OLD."rewardId" AND NEW."rewardId" IS NOT NULL)
     OR (NEW."reversalOfId" IS DISTINCT FROM OLD."reversalOfId" AND NEW."reversalOfId" IS NOT NULL)
     OR (NEW."correctionOfId" IS DISTINCT FROM OLD."correctionOfId" AND NEW."correctionOfId" IS NOT NULL)
     OR (OLD."reversedAt" IS NOT NULL AND NEW."reversedAt" IS DISTINCT FROM OLD."reversedAt")
  THEN
    RAISE EXCEPTION 'PunchLedger is append-only: % may not be edited', OLD."id"
      USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END
$$;
