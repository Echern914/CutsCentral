-- SMS consent (TCPA) tracking.
--
-- A client becomes textable only when optedOut = false AND smsConsentAt IS NOT
-- NULL. Existing synced clients have no proof of opt-in, so we deliberately do
-- NOT backfill smsConsentAt - they stay un-textable until consent is granted
-- (Acuity intake checkbox, barber attestation, or manual opt-in). This is the
-- safety gate; without it, flipping DRY_RUN to false would text people who
-- never agreed.
ALTER TABLE "Client" ADD COLUMN "smsConsentAt" TIMESTAMP(3);
ALTER TABLE "Client" ADD COLUMN "smsConsentSource" TEXT;

-- Barber's explicit attestation that they will only add/text consented clients
-- and are authorized to send on their behalf. Captured at signup or first
-- onboarding step. Nullable: pre-existing accounts have not attested yet.
ALTER TABLE "User" ADD COLUMN "smsAttestedAt" TIMESTAMP(3);
