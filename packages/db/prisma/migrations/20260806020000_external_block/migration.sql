-- Blocked-off time synced FROM the external booking system (Acuity). Without
-- it, time a barber blocks in Acuity is invisible here: the native slot picker
-- offers it, the calendar can't explain the gap, and Chair time counts it as
-- open capacity that went unsold.
--
-- Shop-wide like synced Visits (no calendar->Staff mapping exists), keyed by
-- "acuity:{id}" so a re-sync upserts rather than duplicating.

CREATE TABLE "ExternalBlock" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "externalCalendarId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalBlock_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalBlock_shopId_externalId_key"
  ON "ExternalBlock"("shopId", "externalId");
CREATE INDEX "ExternalBlock_shopId_startsAt_idx"
  ON "ExternalBlock"("shopId", "startsAt");

ALTER TABLE "ExternalBlock" ADD CONSTRAINT "ExternalBlock_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS defense-in-depth: same tenant-isolation pattern as the other shop tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON "ExternalBlock" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ExternalBlock']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING ("shopId" = current_shop_id())
        WITH CHECK ("shopId" = current_shop_id());
    $f$, t);
  END LOOP;
END
$$;
