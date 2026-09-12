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

/* 🔴 A LEDGER ROW MAY NOT PAIR ONE SHOP WITH ANOTHER SHOP'S CLIENT.

   A balance is money-shaped, and it is read as sum(earned) - sum(redeemed)
   over (shopId, clientId). Row-level security asks only "is this row's shopId
   mine?", and a row stamped with MY shopId carrying YOUR client answers yes -
   so it would be counted into a balance at a shop that never earned it, by a
   customer who is not that shop's. The single-column foreign key underneath
   only ever checked that the client exists SOMEWHERE.

   The trigger above deliberately PERMITS re-pointing clientId, because that is
   how a duplicate merge moves history onto the surviving record. This is what
   keeps that door from opening onto another shop.

   The referenced pair must be unique for a composite foreign key to point at
   it; `id` is already the primary key, so this adds no restriction on Client.
   Created only if absent - PR #413 and the My ChairBack migration add the same
   constraint under the same name, and whichever runs first must not make the
   others fail. */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Client_id_shopId_key' AND conrelid = '"Client"'::regclass
  ) THEN
    ALTER TABLE "Client" ADD CONSTRAINT "Client_id_shopId_key" UNIQUE ("id", "shopId");
  END IF;
END $$;

/* Say plainly what is wrong BEFORE the constraint says it cryptically: if any
   existing row already pairs a shop with another shop's client, this migration
   stops the deploy with a count rather than "violates foreign key constraint".
   The old build keeps serving while somebody looks. */
DO $$
DECLARE bad bigint;
BEGIN
  SELECT count(*) INTO bad
    FROM "PunchLedger" p
    JOIN "Client" c ON c."id" = p."clientId"
   WHERE c."shopId" <> p."shopId";
  IF bad > 0 THEN
    RAISE EXCEPTION
      'PunchLedger has % row(s) whose client belongs to another shop; fix them before this migration can add PunchLedger_client_same_shop_fkey', bad;
  END IF;
END $$;

ALTER TABLE "PunchLedger"
  ADD CONSTRAINT "PunchLedger_client_same_shop_fkey"
  FOREIGN KEY ("clientId", "shopId") REFERENCES "Client"("id", "shopId")
  ON DELETE CASCADE ON UPDATE CASCADE;

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
