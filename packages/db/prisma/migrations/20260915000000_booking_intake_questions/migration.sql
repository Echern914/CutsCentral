-- Booking intake questions (PR: what a shop must ask before it can do the job).
-- Additive only: one new tenant table, one Appointment column with a default.
-- No existing row changes value; every shop starts with zero questions, which
-- renders exactly the booking form that ships today.

-- How a question is asked. A closed set: the public form renders a different
-- input per value, and a value with no rendering would be an unanswerable field.
CREATE TYPE "BookingQuestionKind" AS ENUM (
  'text', 'textarea', 'address', 'select', 'phone', 'email', 'number'
);

CREATE TABLE "BookingQuestion" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "helpText" TEXT,
    "kind" "BookingQuestionKind" NOT NULL DEFAULT 'text',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "templateKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingQuestion_pkey" PRIMARY KEY ("id")
);

-- The public booking page's read: this shop's live questions, in order.
CREATE INDEX "BookingQuestion_shopId_active_sortOrder_idx"
  ON "BookingQuestion"("shopId", "active", "sortOrder");

-- Seeding the business type's suggested questions is idempotent: a second tap
-- can never duplicate one. NULL templateKey (a question the owner wrote) is
-- exempt, because NULLs do not collide in a Postgres unique index - which is
-- exactly the behaviour wanted here.
CREATE UNIQUE INDEX "BookingQuestion_shopId_templateKey_key"
  ON "BookingQuestion"("shopId", "templateKey");

ALTER TABLE "BookingQuestion"
  ADD CONSTRAINT "BookingQuestion_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The answers, snapshotted onto the booking. Frozen at booking time so editing
-- or deleting a question never rewrites what a customer already answered.
ALTER TABLE "Appointment" ADD COLUMN "intake" JSONB NOT NULL DEFAULT '[]';

/* Tenant isolation, like every other shop table: the app role reads and writes
   only the shop in app.current_shop_id (see packages/db/src/tenant.ts). */
GRANT SELECT, INSERT, UPDATE, DELETE ON "BookingQuestion" TO chairback_app;
ALTER TABLE "BookingQuestion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookingQuestion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "BookingQuestion";
CREATE POLICY tenant_isolation ON "BookingQuestion"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
