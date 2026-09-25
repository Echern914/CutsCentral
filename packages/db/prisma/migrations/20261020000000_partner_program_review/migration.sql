-- Partner program, review round.
--
-- 1. PartnerReferral.creditPaymentIntentId: the payment that paid the invoice
--    that earned the reward. A refund on Stripe API 2025-03-31.basil and later
--    (charge.refunded) and a dispute on EVERY version (charge.dispute.created)
--    carry the payment intent, never the invoice, so without this neither
--    could find the reward to reverse it.
-- 2. PartnerCashout DECLINED: an admin can close a request without paying it
--    (partner paused for abuse, rewards reversed after the ask). A declined
--    request stops holding the partner's balance.
--
-- The tables stay default-deny (REVOKE + FORCED RLS from the first migration);
-- adding columns does not change grants or policies.

-- AlterTable
ALTER TABLE "PartnerReferral" ADD COLUMN "creditPaymentIntentId" TEXT;

-- CreateIndex
CREATE INDEX "PartnerReferral_creditPaymentIntentId_idx" ON "PartnerReferral"("creditPaymentIntentId");

-- A payment intent is part of the credit: an uncredited row never has one.
ALTER TABLE "PartnerReferral"
    ADD CONSTRAINT "PartnerReferral_payment_intent_check" CHECK (
        "creditPaymentIntentId" IS NULL OR "creditedAt" IS NOT NULL
    );

-- AlterTable
ALTER TABLE "PartnerCashout" ADD COLUMN "declinedAt" TIMESTAMP(3),
ADD COLUMN "declinedByUserId" TEXT;

-- REQUESTED, PAID or DECLINED - each with exactly its own stamps.
ALTER TABLE "PartnerCashout" DROP CONSTRAINT "PartnerCashout_status_check";
ALTER TABLE "PartnerCashout"
    ADD CONSTRAINT "PartnerCashout_status_check" CHECK (
        ("status" = 'REQUESTED' AND "paidAt" IS NULL AND "paidByUserId" IS NULL
            AND "declinedAt" IS NULL AND "declinedByUserId" IS NULL)
        OR ("status" = 'PAID' AND "paidAt" IS NOT NULL AND "paidByUserId" IS NOT NULL
            AND "declinedAt" IS NULL AND "declinedByUserId" IS NULL)
        OR ("status" = 'DECLINED' AND "declinedAt" IS NOT NULL AND "declinedByUserId" IS NOT NULL
            AND "paidAt" IS NULL AND "paidByUserId" IS NULL)
    );
