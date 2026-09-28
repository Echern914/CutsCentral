-- A shop's own booking policies, and the checklist a customer ticks before
-- booking (config/bookingPolicy.ts).
--
-- Additive only. Every existing shop gets NULL text and an empty checklist,
-- which means OFF: its booking page shows and enforces exactly what it did
-- before. Every existing appointment gets NULL agreement columns, which means
-- no checklist was asked - the truth for all of them.
ALTER TABLE "Shop" ADD COLUMN "bookingPolicyText" TEXT;
ALTER TABLE "Shop" ADD COLUMN "bookingPolicyChecklist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "Appointment" ADD COLUMN "policyAcceptedAt" TIMESTAMP(3);
ALTER TABLE "Appointment" ADD COLUMN "policySnapshot" JSONB;
