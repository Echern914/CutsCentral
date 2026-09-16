/* "Add to my shops": a shop a customer keeps in My ChairBack by name, whether
   or not they have ever been a client there.

   The shop may see who saved it - the saver's NAME, from their own account, and
   when. Never a phone or an email: a shop holding a stranger's number could text
   someone who never opted in to its messages.

   Platform-owned, like every Customer* table. The tenant role holds no privilege
   and no policy, so a shop-scoped session reads and writes nothing here. The
   dashboard's "saved your shop" list reads it as owner, filtered to that shop. */

CREATE TABLE "CustomerSavedShop" (
  "id"        TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "shopId"    TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CustomerSavedShop_pkey" PRIMARY KEY ("id")
);

-- Saving twice is still one save.
CREATE UNIQUE INDEX "CustomerSavedShop_accountId_shopId_key" ON "CustomerSavedShop"("accountId", "shopId");
-- The shop's list, newest first.
CREATE INDEX "CustomerSavedShop_shopId_createdAt_idx" ON "CustomerSavedShop"("shopId", "createdAt");

-- Deleting the account, or the shop, takes the save with it.
ALTER TABLE "CustomerSavedShop" ADD CONSTRAINT "CustomerSavedShop_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerSavedShop" ADD CONSTRAINT "CustomerSavedShop_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/* Same lock as the other customer tables (20260922000000). REVOKE because a
   default privilege would otherwise hand the new table to the tenant role;
   zero policies + FORCE means that role sees nothing even if one slipped back. */
REVOKE ALL ON "CustomerSavedShop" FROM chairback_app;
ALTER TABLE "CustomerSavedShop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerSavedShop" FORCE ROW LEVEL SECURITY;
