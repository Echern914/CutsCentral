/* SHOP EXPENSES: what the business spends, so Insights can show a
   take-home ESTIMATE (revenue from bookings minus expenses entered).

   One row is one expense the barber typed in: booth/chair rent they PAY,
   product purchases, supplies, anything else. Either a single date ('once')
   or a recurring amount ('weekly' / 'monthly') from a start date, with an
   optional end date. Occurrences are never stored: they are expanded at read
   time by @chairback/config/expenseSchedule, so editing an amount re-prices
   every period consistently and there is no ledger to keep in sync.

   🔴 NOT booth rent the owner RECEIVES. BoothRentRate / BoothRentPayment are
   income from team members and are untouched here.

   Dates are SHOP-LOCAL calendar dates (DATE, no time, no zone): "rent is due
   on the 1st" means the 1st on the shop's wall calendar, whatever the server
   zone.

   Additive. Nothing existing changes shape. Soft delete via archivedAt, so an
   archived expense stops counting in every period, past ones included. */

CREATE TABLE "ShopExpense" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "label" TEXT,
    "amountCents" INTEGER NOT NULL,
    "cadence" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "ShopExpense_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ShopExpense_category_check"
      CHECK ("category" IN ('rent', 'products', 'supplies', 'other')),
    CONSTRAINT "ShopExpense_cadence_check"
      CHECK ("cadence" IN ('once', 'weekly', 'monthly')),
    -- Never zero or negative, and never a typo'd extra zero past $100,000 for
    -- one line. Mirrors EXPENSE_MAX_CENTS in @chairback/config/expenseSchedule.
    CONSTRAINT "ShopExpense_amount_check"
      CHECK ("amountCents" BETWEEN 1 AND 10000000),
    CONSTRAINT "ShopExpense_label_check"
      CHECK ("label" IS NULL OR char_length("label") <= 80),
    -- An end date is inclusive and never before the start. A one-time expense
    -- has no end date: its date IS startDate.
    CONSTRAINT "ShopExpense_dates_check"
      CHECK ("endDate" IS NULL OR "endDate" >= "startDate"),
    CONSTRAINT "ShopExpense_once_no_end_check"
      CHECK ("cadence" <> 'once' OR "endDate" IS NULL)
);

CREATE INDEX "ShopExpense_shopId_archivedAt_idx" ON "ShopExpense"("shopId", "archivedAt");

ALTER TABLE "ShopExpense" ADD CONSTRAINT "ShopExpense_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/* The shop's own: tenant isolation, like Offer. */
GRANT SELECT, INSERT, UPDATE, DELETE ON "ShopExpense" TO chairback_app;
ALTER TABLE "ShopExpense" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopExpense" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ShopExpense";
CREATE POLICY tenant_isolation ON "ShopExpense"
  USING ("shopId" = current_shop_id())
  WITH CHECK ("shopId" = current_shop_id());
