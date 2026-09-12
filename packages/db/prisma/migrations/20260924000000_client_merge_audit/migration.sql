-- One row per merge of two duplicate client records: who, when, why, and what
-- moved. Written in the merge's own transaction. Additive only.

CREATE TABLE "ClientMergeEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "survivorClientId" TEXT NOT NULL,
    "mergedClientId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "reason" TEXT,
    "moved" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientMergeEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ClientMergeEvent_shopId_survivorClientId_createdAt_idx"
  ON "ClientMergeEvent"("shopId", "survivorClientId", "createdAt");
CREATE INDEX "ClientMergeEvent_shopId_mergedClientId_idx"
  ON "ClientMergeEvent"("shopId", "mergedClientId");
ALTER TABLE "ClientMergeEvent"
  ADD CONSTRAINT "ClientMergeEvent_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClientMergeEvent"
  ADD CONSTRAINT "ClientMergeEvent_distinct_clients"
  CHECK ("survivorClientId" <> "mergedClientId");
ALTER TABLE "ClientMergeEvent"
  ADD CONSTRAINT "ClientMergeEvent_reason_check"
  CHECK ("reason" IS NULL OR char_length(btrim("reason")) BETWEEN 1 AND 500);

/* Append-only for everyone, the connection owner included - a grant is not
   immutability; the trigger is. DELETE still works so a shop teardown can
   cascade (the same stance as AppointmentPriceChange). */
CREATE OR REPLACE FUNCTION client_merge_event_immutable() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'ClientMergeEvent is append-only: UPDATE is not permitted'
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER client_merge_event_no_update
  BEFORE UPDATE ON "ClientMergeEvent"
  FOR EACH ROW EXECUTE FUNCTION client_merge_event_immutable();

/* 🔴 BOTH RECORDS MUST BELONG TO THE SHOP THE EVENT IS STAMPED WITH.

   This row is the evidence for a merge - what moved, and from which record to
   which. A row pairing this shop with another shop's client would be a false
   account of somebody else's data, written under this shop's tenant policy.

   Checked AT INSERT rather than with a foreign key, because a merge record has
   to OUTLIVE the rows it describes: a composite FK would either cascade the
   evidence away or block the deletion that makes it matter. Same reasoning as
   the ids being plain columns here (AppointmentPriceChange does it too).

   SECURITY DEFINER with a pinned search_path so the check sees the real rows
   under the tenant role, where Client is only visible through the policy -
   exactly the stance PunchLedger's append-only trigger takes. */
CREATE OR REPLACE FUNCTION client_merge_event_same_shop() RETURNS trigger AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Client"
     WHERE "id" = NEW."survivorClientId" AND "shopId" = NEW."shopId"
  ) OR NOT EXISTS (
    SELECT 1 FROM "Client"
     WHERE "id" = NEW."mergedClientId" AND "shopId" = NEW."shopId"
  ) THEN
    RAISE EXCEPTION 'ClientMergeEvent: both clients must belong to shop %', NEW."shopId"
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER client_merge_event_same_shop
  BEFORE INSERT ON "ClientMergeEvent"
  FOR EACH ROW EXECUTE FUNCTION client_merge_event_same_shop();

/* Tenant isolation, like every other shop table. */
GRANT SELECT, INSERT ON "ClientMergeEvent" TO chairback_app;
REVOKE UPDATE, DELETE ON "ClientMergeEvent" FROM chairback_app;
ALTER TABLE "ClientMergeEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientMergeEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ClientMergeEvent";
CREATE POLICY tenant_isolation ON "ClientMergeEvent"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
