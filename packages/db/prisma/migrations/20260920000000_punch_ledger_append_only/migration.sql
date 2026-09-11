/* PUNCH LEDGER: who, why, and never rewritten.

   1. Two new columns, nullable (history written before today has no actor):
        "actorUserId" - who made a MANUAL change (bonus, undo, edit, redeem)
        "reason"      - why, in their words. Staff-only text: customer
                        surfaces select explicit fields and never this one.
   2. Deleting a Visit no longer deletes its ledger rows (FK CASCADE -> SET
      NULL). A visit that stops counting is clawed back with offsetting rows
      first; the link is detached, the history stays.
   3. A trigger makes the ledger append-only at the DATABASE, not by
      convention:
        - UPDATE may only stamp reversedAt (once), detach a link
          (visitId / rewardId / reversalOfId / correctionOfId / actorUserId
          -> NULL, which is also what the FK SET NULL actions do), or
          re-point clientId (merging two duplicate records of one person).
          Amounts, balances, notes, cards, reasons and dates are frozen.
        - DELETE is refused unless the row's client or shop no longer exists
          (a cascade from tearing either down), or the transaction has
          explicitly declared a teardown (the demo tenant's nightly reset).

   Additive and reversible: dropping the trigger, the function, the two
   columns and restoring the CASCADE puts the table back exactly. No existing
   row is written. */

ALTER TABLE "PunchLedger" ADD COLUMN "actorUserId" TEXT;
ALTER TABLE "PunchLedger" ADD COLUMN "reason" TEXT;

ALTER TABLE "PunchLedger"
  ADD CONSTRAINT "PunchLedger_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "PunchLedger_actorUserId_idx" ON "PunchLedger"("actorUserId");

ALTER TABLE "PunchLedger"
  ADD CONSTRAINT "PunchLedger_reason_check"
  CHECK ("reason" IS NULL OR char_length(btrim("reason")) BETWEEN 1 AND 500);

ALTER TABLE "PunchLedger" DROP CONSTRAINT "PunchLedger_visitId_fkey";
ALTER TABLE "PunchLedger"
  ADD CONSTRAINT "PunchLedger_visitId_fkey"
  FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

/* SECURITY DEFINER so the teardown checks see the real Client/Shop rows even
   when the statement runs under the tenant role (where Shop is default-deny
   and would always look "gone" - which would quietly re-open deletes). The
   search_path is pinned, as a definer function must. */
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

CREATE TRIGGER "PunchLedger_append_only"
  BEFORE UPDATE OR DELETE ON "PunchLedger"
  FOR EACH ROW EXECUTE FUNCTION punch_ledger_append_only();
