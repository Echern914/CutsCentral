-- Back-to-back group booking: "me and my brother, one after the other, with
-- the same barber". One visit, several chairs in a row.
--
-- 🔴 A REAL TABLE, NOT AN INFERENCE. The tempting alternative is to treat
-- adjacent appointments sharing a phone number as a group. That is wrong in
-- both directions: it INVENTS groups (a father booked at 2:00 and his son at
-- 2:30, on separate visits, are not one party) and it LOSES real ones (three
-- attendees, one cancels, the adjacency evaporates and the remaining two stop
-- being a group). Worse, a cancellation UI built on such a rule would offer to
-- cancel a stranger's appointment. Group identity is recorded at creation and
-- read from nowhere else.
--
-- 🔴 The name is AppointmentGroup, not BookingGroup, because
-- "Shop"."bookingGroupsFirst" already exists and means SERVICE groups on the
-- public booking menu. Two "booking group" concepts in one schema would be a
-- permanent reading hazard.
--
-- Everything here is additive: no existing row changes meaning, and every
-- appointment written before this migration has a NULL groupId, which is
-- exactly what "an ordinary single booking" means.

CREATE TYPE "AppointmentGroupStatus" AS ENUM ('ACTIVE', 'CANCELED');

CREATE TABLE "AppointmentGroup" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "clientId" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "manageToken" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "status" "AppointmentGroupStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "canceledAt" TIMESTAMP(3),

    CONSTRAINT "AppointmentGroup_pkey" PRIMARY KEY ("id")
);

-- Login-less management of the whole group, exactly like a recurring series.
CREATE UNIQUE INDEX "AppointmentGroup_manageToken_key" ON "AppointmentGroup"("manageToken");

-- 🔴 IDEMPOTENT RETRIES, and the reason this is a UNIQUE INDEX rather than a
-- check in application code. Creating a group is several appointments in one
-- transaction; a client that retries a request whose response it never saw
-- must get the SAME group back, never a second set of chairs. Unique means the
-- retry LOSES the insert race at the database and can then read the winner -
-- a race two concurrent submissions genuinely run, and which no amount of
-- "select then insert" would settle.
--
-- 🔴 NULLs ARE DISTINCT in a Postgres unique index, so this does NOT need to be
-- partial: any number of rows may carry a NULL key. A group created by hand has
-- no request to be idempotent about.
CREATE UNIQUE INDEX "AppointmentGroup_idempotencyKey_key" ON "AppointmentGroup"("idempotencyKey");

CREATE INDEX "AppointmentGroup_shopId_status_idx" ON "AppointmentGroup"("shopId", "status");
CREATE INDEX "AppointmentGroup_shopId_staffId_idx" ON "AppointmentGroup"("shopId", "staffId");

ALTER TABLE "AppointmentGroup" ADD CONSTRAINT "AppointmentGroup_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Restrict, like every other staff reference: a barber with bookings on the
-- books cannot be deleted out from under them.
ALTER TABLE "AppointmentGroup" ADD CONSTRAINT "AppointmentGroup_staffId_fkey"
  FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AppointmentGroup" ADD CONSTRAINT "AppointmentGroup_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The appointment's membership.
ALTER TABLE "Appointment" ADD COLUMN "groupId" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "groupPosition" INTEGER;

-- SetNull, matching seriesId and for the same reason: releasing a group must
-- never delete an occurrence whose Visit/PunchLedger already granted punches.
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "AppointmentGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- "The rest of this group" - the lookup behind view, reschedule-all and
-- cancel-all.
--
-- Plain, not partial, and matching `@@index([groupId])` in schema.prisma
-- exactly. A partial index here would be slightly smaller but it would DRIFT
-- from what Prisma believes exists, and the next `migrate dev` would try to
-- "fix" it. seriesId - the same shape of mostly-NULL link - is a plain index
-- for the same reason.
CREATE INDEX "Appointment_groupId_idx" ON "Appointment"("groupId");

-- 🔴 ONE POSITION PER GROUP. Two appointments claiming position 1 would make
-- "who is next?" unanswerable and the sequence shown to the customer would
-- depend on row order.
--
-- Partial, and therefore NOT declared in schema.prisma: Prisma cannot express
-- a WHERE clause on an index, so it gets its own name and lives only here -
-- the same arrangement as "Appointment_staff_start_active_uq", the partial
-- unique that has backstopped double-booking since native booking shipped.
-- 🔴 Postgres treats NULLs as DISTINCT, so an unfiltered version would already
-- permit unlimited (NULL, NULL) rows; the WHERE is here to say plainly that
-- ordinary appointments are not participating, not to make it work.
CREATE UNIQUE INDEX "Appointment_group_position_uq"
  ON "Appointment"("groupId", "groupPosition")
  WHERE "groupId" IS NOT NULL;

/* Tenant isolation, like every other shop-owned table. */
GRANT SELECT, INSERT, UPDATE, DELETE ON "AppointmentGroup" TO chairback_app;
ALTER TABLE "AppointmentGroup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AppointmentGroup" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AppointmentGroup";
CREATE POLICY tenant_isolation ON "AppointmentGroup"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
