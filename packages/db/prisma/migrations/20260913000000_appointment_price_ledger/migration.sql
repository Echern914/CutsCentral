-- Append-only ledger for by-hand appointment price / chair-figure edits
-- (POST /appointments/:id/price, PR #400). Additive only.

CREATE TABLE "AppointmentPriceChange" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "fromPriceCents" INTEGER,
    "toPriceCents" INTEGER NOT NULL,
    "fromCollectedCents" INTEGER,
    "toCollectedCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentPriceChange_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AppointmentPriceChange_shopId_appointmentId_createdAt_idx"
  ON "AppointmentPriceChange"("shopId", "appointmentId", "createdAt");
ALTER TABLE "AppointmentPriceChange"
  ADD CONSTRAINT "AppointmentPriceChange_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/* Money is integer cents and never negative. */
ALTER TABLE "AppointmentPriceChange"
  ADD CONSTRAINT "AppointmentPriceChange_cents_nonnegative"
  CHECK ("toPriceCents" >= 0
     AND ("fromPriceCents" IS NULL OR "fromPriceCents" >= 0)
     AND ("fromCollectedCents" IS NULL OR "fromCollectedCents" >= 0)
     AND ("toCollectedCents" IS NULL OR "toCollectedCents" >= 0));

/* Append-only for EVERYONE, the connection owner included. A grant is not
   immutability; the trigger is. DELETE deliberately still works (a shop
   cascade must succeed) - retention stays a policy decision. */
CREATE OR REPLACE FUNCTION appointment_price_change_immutable() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'AppointmentPriceChange is append-only: UPDATE is not permitted'
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appointment_price_change_no_update ON "AppointmentPriceChange";
CREATE TRIGGER appointment_price_change_no_update
  BEFORE UPDATE ON "AppointmentPriceChange"
  FOR EACH ROW EXECUTE FUNCTION appointment_price_change_immutable();

/* Tenant isolation, like every other shop table. The app role may read and
   append its own shop's rows and nothing else. */
GRANT SELECT, INSERT ON "AppointmentPriceChange" TO chairback_app;
REVOKE UPDATE, DELETE ON "AppointmentPriceChange" FROM chairback_app;
ALTER TABLE "AppointmentPriceChange" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AppointmentPriceChange" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AppointmentPriceChange";
CREATE POLICY tenant_isolation ON "AppointmentPriceChange"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
