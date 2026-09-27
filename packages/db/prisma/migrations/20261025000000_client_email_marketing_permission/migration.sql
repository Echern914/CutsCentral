-- Marketing email needs a customer's PERMISSION, recorded as its own dated fact
-- with where it came from - never inferred from having an address, a booking,
-- a visit or a linked account. Broadcast email reaches only clients who have it.
--
-- Additive and nullable only: no default, no backfill. null = "has not said
-- yes", which is every existing row - so until a permission is recorded, no
-- client is eligible for broadcast email. (No production email broadcast has
-- ever been sent, so nobody loses a message they were getting.)
ALTER TABLE "Client" ADD COLUMN "emailMarketingConsentAt" TIMESTAMP(3),
ADD COLUMN "emailMarketingConsentSource" TEXT;
