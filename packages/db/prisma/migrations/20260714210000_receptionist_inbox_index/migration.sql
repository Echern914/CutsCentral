-- Barber inbox list query: conversations for a shop, newest activity first.
-- Additive index only; no data or behavior change.
CREATE INDEX "ReceptionistConversation_shopId_lastMessageAt_idx"
  ON "ReceptionistConversation"("shopId", "lastMessageAt");
