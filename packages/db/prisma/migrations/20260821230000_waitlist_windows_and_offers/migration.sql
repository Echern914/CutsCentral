-- Waitlist, phase A: shape only. ZERO behaviour change.
--
-- Nothing reads these columns or tables yet. The client flow (PR B), the
-- offer/hold that fixes the double-booking race (PR C) and the matcher (PR D)
-- land separately. This migration exists so those can be additive too.
--
-- Every existing entry keeps working exactly as it does: slotOpened still
-- matches on serviceId/staffId, still nudges by push + email, still alerts the
-- barber by SMS. The backfill below gives each one a single "Any date / Any
-- time" window, which is precisely what its behaviour already is.

/* ---------------------------------------------------------------- */
/* 1. WaitlistEntry: preferences, consent, self-service, booked link  */
/* ---------------------------------------------------------------- */

ALTER TABLE "WaitlistEntry"
  ADD COLUMN "timezone"            TEXT,
  ADD COLUMN "minHoursNotice"      INTEGER,
  -- 🔴 NOT BACKFILLED, deliberately. Nobody who already joined was asked, so
  -- every existing row stays NULL. Customer SMS stays out of scope until 10DLC
  -- clears; capturing consent now means the record exists the day it does.
  ADD COLUMN "smsConsentAt"        TIMESTAMP(3),
  ADD COLUMN "smsConsentSource"    TEXT,
  -- Hashed, never the token. It travels in an emailed link, so a leaked backup
  -- must not hand out the ability to cancel someone's place.
  ADD COLUMN "cancelTokenHash"     TEXT,
  ADD COLUMN "bookedAppointmentId" TEXT,
  ADD COLUMN "expiresAt"           TIMESTAMP(3);

CREATE UNIQUE INDEX "WaitlistEntry_cancelTokenHash_key"
  ON "WaitlistEntry"("cancelTokenHash");
CREATE UNIQUE INDEX "WaitlistEntry_bookedAppointmentId_key"
  ON "WaitlistEntry"("bookedAppointmentId");
CREATE INDEX "WaitlistEntry_shopId_status_expiresAt_idx"
  ON "WaitlistEntry"("shopId", "status", "expiresAt");

ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_bookedAppointmentId_fkey"
  FOREIGN KEY ("bookedAppointmentId") REFERENCES "Appointment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Pin the status vocabulary. EXPIRED is new and nothing writes it yet; the
-- other four are every value in use today, so this validates against existing
-- rows without a rewrite. A CHECK rather than an enum because promoting the
-- column type is not an additive change.
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_status_check"
  CHECK ("status" IN ('WAITING', 'CONTACTED', 'BOOKED', 'REMOVED', 'EXPIRED'));

/* ---------------------------------------------------------------- */
/* 2. WaitlistWindow: up to five date/time preferences per entry      */
/* ---------------------------------------------------------------- */

CREATE TABLE "WaitlistWindow" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    -- Shop-local calendar dates, 'YYYY-MM-DD'. NULL = any date.
    "startDate" TEXT,
    "endDate" TEXT,
    -- Minutes from shop-local midnight, end exclusive. NULL = any time.
    "startMin" INTEGER,
    "endMin" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WaitlistWindow_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WaitlistWindow_shopId_entryId_idx"
  ON "WaitlistWindow"("shopId", "entryId");

ALTER TABLE "WaitlistWindow" ADD CONSTRAINT "WaitlistWindow_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WaitlistWindow" ADD CONSTRAINT "WaitlistWindow_entryId_fkey"
  FOREIGN KEY ("entryId") REFERENCES "WaitlistEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A window is either open-ended or ordered - never backwards. Both halves are
-- independently nullable, so each side is checked on its own.
ALTER TABLE "WaitlistWindow" ADD CONSTRAINT "WaitlistWindow_date_order_check"
  CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "startDate" <= "endDate");
ALTER TABLE "WaitlistWindow" ADD CONSTRAINT "WaitlistWindow_time_order_check"
  CHECK (
    ("startMin" IS NULL AND "endMin" IS NULL)
    OR ("startMin" IS NOT NULL AND "endMin" IS NOT NULL
        AND "startMin" >= 0 AND "endMin" <= 1440 AND "startMin" < "endMin")
  );

/* ---------------------------------------------------------------- */
/* 3. WaitlistOffer: one held slot, offered to one client             */
/* ---------------------------------------------------------------- */

CREATE TABLE "WaitlistOffer" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    -- Hashed. The raw token is in a one-time claim link.
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OFFERED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAppointmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WaitlistOffer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WaitlistOffer_tokenHash_key" ON "WaitlistOffer"("tokenHash");
CREATE UNIQUE INDEX "WaitlistOffer_claimedAppointmentId_key"
  ON "WaitlistOffer"("claimedAppointmentId");
CREATE INDEX "WaitlistOffer_shopId_status_expiresAt_idx"
  ON "WaitlistOffer"("shopId", "status", "expiresAt");
CREATE INDEX "WaitlistOffer_shopId_staffId_startsAt_idx"
  ON "WaitlistOffer"("shopId", "staffId", "startsAt");
CREATE INDEX "WaitlistOffer_entryId_idx" ON "WaitlistOffer"("entryId");

ALTER TABLE "WaitlistOffer" ADD CONSTRAINT "WaitlistOffer_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WaitlistOffer" ADD CONSTRAINT "WaitlistOffer_entryId_fkey"
  FOREIGN KEY ("entryId") REFERENCES "WaitlistEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WaitlistOffer" ADD CONSTRAINT "WaitlistOffer_claimedAppointmentId_fkey"
  FOREIGN KEY ("claimedAppointmentId") REFERENCES "Appointment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WaitlistOffer" ADD CONSTRAINT "WaitlistOffer_status_check"
  CHECK ("status" IN ('OFFERED', 'CLAIMED', 'EXPIRED', 'RELEASED'));
ALTER TABLE "WaitlistOffer" ADD CONSTRAINT "WaitlistOffer_span_check"
  CHECK ("endsAt" > "startsAt");

-- 🔑 ONE ACTIVE OFFER PER PHYSICAL SLOT.
--
-- This is the whole point of the table, and it is a DATABASE guarantee rather
-- than something the matcher has to remember. Today a cancellation emails the
-- same booking link to up to five people and lets them race; with this, a
-- second concurrent offer on the same (staff, instant) cannot even be
-- inserted while one is still live.
--
-- Partial, on status = 'OFFERED' only: an expired or released offer must not
-- block the slot being offered to the next person, and a claimed one is
-- already represented by its Appointment. Same shape as the appointment
-- double-booking guard, which is partial on ('BOOKED','PENDING').
CREATE UNIQUE INDEX "WaitlistOffer_one_active_per_slot"
  ON "WaitlistOffer"("shopId", "staffId", "startsAt")
  WHERE "status" = 'OFFERED';

/* ---------------------------------------------------------------- */
/* 4. Backfill: every existing entry is "Any date / Any time"         */
/* ---------------------------------------------------------------- */

-- All four preference columns NULL = any date, any time, which is exactly the
-- behaviour these entries already have. Idempotent via NOT EXISTS, so a
-- re-applied migration cannot give anyone a second window.
INSERT INTO "WaitlistWindow" ("id", "shopId", "entryId", "createdAt")
SELECT gen_random_uuid()::text, w."shopId", w."id", now()
FROM "WaitlistEntry" w
WHERE NOT EXISTS (
  SELECT 1 FROM "WaitlistWindow" x WHERE x."entryId" = w."id"
);

/* ---------------------------------------------------------------- */
/* 5. RLS: same tenant isolation as every other shop table            */
/* ---------------------------------------------------------------- */

GRANT SELECT, INSERT, UPDATE, DELETE ON "WaitlistWindow" TO chairback_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "WaitlistOffer" TO chairback_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['WaitlistWindow', 'WaitlistOffer']
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
