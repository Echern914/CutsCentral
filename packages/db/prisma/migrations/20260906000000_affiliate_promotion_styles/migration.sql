-- Affiliates choose HOW they'll promote AFTER approval (the flow: sign up ->
-- approve -> choose styles -> dashboard). Fixed vocabulary, CHECK-pinned like
-- every other classification in this program. Empty array = not chosen yet,
-- which is what gates the "choose your styles" screen.
ALTER TABLE "AffiliateAccount"
  ADD COLUMN IF NOT EXISTS "promotionStyles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "stylesChosenAt" TIMESTAMP(3);

ALTER TABLE "AffiliateAccount"
  DROP CONSTRAINT IF EXISTS "AffiliateAccount_promotionStyles_check";
ALTER TABLE "AffiliateAccount"
  ADD CONSTRAINT "AffiliateAccount_promotionStyles_check"
  CHECK ("promotionStyles" <@ ARRAY[
    'short_video', 'posts_stories', 'in_the_chair', 'text_dm',
    'email_list', 'flyer_qr', 'blog_podcast', 'other'
  ]::TEXT[]);

-- One new audit type (account.styles_set). The vocabulary is re-pinned in FULL
-- - never a partial list - so nothing an earlier phase writes stops passing.
ALTER TABLE "AffiliateAuditEvent"
  DROP CONSTRAINT IF EXISTS "AffiliateAuditEvent_type_check";
ALTER TABLE "AffiliateAuditEvent"
  ADD CONSTRAINT "AffiliateAuditEvent_type_check"
  CHECK ("type" IN (
    'application.submitted', 'application.approved', 'application.rejected',
    'account.suspended', 'account.reactivated', 'account.styles_set',
    'attribution.locked', 'attribution.corrected', 'attribution.superseded_by_legacy',
    'reward.qualified', 'reward.available', 'reward.reversed',
    'reward.expired', 'reward.review_flagged',
    'credit.applied', 'credit.adjusted'
  ));
