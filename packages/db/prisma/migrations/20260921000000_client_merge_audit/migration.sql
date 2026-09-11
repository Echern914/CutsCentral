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

/* Tenant isolation, like every other shop table. */
GRANT SELECT, INSERT ON "ClientMergeEvent" TO chairback_app;
REVOKE UPDATE, DELETE ON "ClientMergeEvent" FROM chairback_app;
ALTER TABLE "ClientMergeEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientMergeEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ClientMergeEvent";
CREATE POLICY tenant_isolation ON "ClientMergeEvent"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
