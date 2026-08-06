-- Barber-side notifications: what a barber wants to be told about, and how.
--
-- Every alert before this was REACTIVE (a customer just did something) and
-- unconfigurable. This adds the preference row plus the stamp for the new
-- "your next client" reminder, which is the one thing a barber actually asked
-- for: who is coming, what they booked, when.
--
-- One row per (person, shop) - a barber working two shops can want a morning
-- digest at one and silence at the other. Keyed by userId, not ShopMember,
-- because the OWNER has no ShopMember row.

CREATE TABLE "BarberNotifyPref" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pushEnabled" BOOLEAN NOT NULL DEFAULT true,
    -- Texts about BOOKINGS: default true, because a shop with a notifyPhone
    -- already received these before preferences existed.
    "smsEnabled" BOOLEAN NOT NULL DEFAULT true,
    -- Texts for the RECURRING reminders: opt IN, one per appointment costs.
    "smsRemindersEnabled" BOOLEAN NOT NULL DEFAULT false,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "notifyPhone" TEXT,
    "nextUpEnabled" BOOLEAN NOT NULL DEFAULT true,
    "nextUpLeadMin" INTEGER NOT NULL DEFAULT 30,
    "dayAheadEnabled" BOOLEAN NOT NULL DEFAULT true,
    "dayAheadHour" INTEGER NOT NULL DEFAULT 19,
    "newBookingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "cancelEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BarberNotifyPref_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BarberNotifyPref_userId_shopId_key"
  ON "BarberNotifyPref"("userId", "shopId");
CREATE INDEX "BarberNotifyPref_shopId_idx" ON "BarberNotifyPref"("shopId");

ALTER TABLE "BarberNotifyPref" ADD CONSTRAINT "BarberNotifyPref_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BarberNotifyPref" ADD CONSTRAINT "BarberNotifyPref_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The barber's own at-most-once stamp. Deliberately separate from the client
-- reminder stamps: different recipient, different lead time - a client reminder
-- already sent must never suppress the barber's heads-up.
ALTER TABLE "Appointment" ADD COLUMN "barberNextUpSentAt" TIMESTAMP(3);

-- Finding "appointments starting soon that still need a barber ping" is the
-- hot path of a job that runs every 5 minutes.
CREATE INDEX "Appointment_barberNextUp_idx"
  ON "Appointment"("shopId", "startsAt")
  WHERE "barberNextUpSentAt" IS NULL;

-- RLS defense-in-depth. NOTE the difference from the other tenant tables: this
-- one is read by user-keyed paths too, so the policy allows a row whose shop
-- matches the current context - same tenant_isolation shape as the rest.
GRANT SELECT, INSERT, UPDATE, DELETE ON "BarberNotifyPref" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['BarberNotifyPref']
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

-- withLease() acquires by UPDATE-ing an EXISTING row, so a job whose name has
-- no seeded row matches 0 rows and silently never runs (exactly how
-- acuity-resync shipped dead for a week). expiresAt = now() is already past by
-- the first tick, so the first acquire wins. Matches the *_lease_seed pattern.
INSERT INTO "job_lease" ("name", "holder", "expiresAt", "updatedAt") VALUES
    ('barber-reminders', '', now(), now())
ON CONFLICT ("name") DO NOTHING;
