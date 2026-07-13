-- Pricing tiers + monthly SMS quotas. Shop.plan gains a third value "pro_ai"
-- (Premium AI, $74.99/mo - includes the receptionist); no column change needed
-- (plan is already a free-form String). This index serves the two new hot
-- queries added with per-tier quotas:
--   (a) monthly usage count: shopId + kind IN (marketing kinds) + createdAt >= month start
--   (b) receptionist reply caps: shopId (+ clientId via the existing
--       [shopId, clientId, createdAt] index) + kind + createdAt >= day start
CREATE INDEX "Nudge_shopId_kind_createdAt_idx" ON "Nudge"("shopId", "kind", "createdAt");
