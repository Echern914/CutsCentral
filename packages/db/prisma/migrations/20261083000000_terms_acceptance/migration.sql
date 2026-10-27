-- TERMS ACCEPTANCE (clickwrap): who agreed to which Terms of Service and
-- Privacy Policy, and when.
--
-- Additive and nullable. NULL = never agreed on record (every account that
-- predates this, and an account made through Google/Apple sign-in until the
-- dashboard's "Before you continue" screen is answered).
--   termsAcceptedAt      - when they ticked the box (server clock).
--   termsAcceptedVersion - TERMS_VERSION (@chairback/config/legal) at that
--                          moment, e.g. '2026-10-27'. A different value than
--                          the current one asks them to agree again, once.
-- Deliberately no IP or user agent: a timestamp and a version are the record.

ALTER TABLE "User" ADD COLUMN "termsAcceptedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "termsAcceptedVersion" TEXT;

ALTER TABLE "CustomerAccount" ADD COLUMN "termsAcceptedAt" TIMESTAMP(3);
ALTER TABLE "CustomerAccount" ADD COLUMN "termsAcceptedVersion" TEXT;
