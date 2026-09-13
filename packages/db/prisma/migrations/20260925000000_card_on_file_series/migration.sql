-- ONE CARD FOR A WHOLE STANDING APPOINTMENT.
--
-- A card-on-file shop keeps a card at booking. For a series the customer makes
-- ONE commitment and agrees to ONE card, so there is one CardOnFile row for the
-- series rather than one per occurrence - twelve SetupIntents for twelve halves
-- of a single decision would be twelve chances to half-fail, and twelve cards
-- to detach when the customer cancels in March.
--
-- `appointmentId` deliberately KEEPS its NOT NULL + UNIQUE and keeps pointing at
-- the series ANCHOR (occurrence 0). That is what makes this additive: every
-- existing path - markCardSaved, verifyCardSaved, releaseCardOnFile,
-- chargeCardOnFile, the settle job - looks the row up by appointmentId and
-- continues to work untouched, for single bookings and for the anchor alike.
-- The new column is only how the OTHER eleven occurrences find the card.
ALTER TABLE "CardOnFile" ADD COLUMN "seriesId" TEXT;

-- One card per series. This is the constraint that makes a double-submit safe:
-- a retry cannot mint a second Customer + SetupIntent for a series that already
-- has one, no matter how the race is lost.
CREATE UNIQUE INDEX "CardOnFile_seriesId_key" ON "CardOnFile"("seriesId");

-- The single-column foreign key the `series` relation in schema.prisma implies.
-- Prisma generates this one; the composite below is added on top of it, exactly
-- as BroadcastSend carries both clientId_fkey and client_same_shop_fkey.
ALTER TABLE "CardOnFile" ADD CONSTRAINT "CardOnFile_seriesId_fkey"
  FOREIGN KEY ("seriesId") REFERENCES "RecurringSeries"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 🔴 A CARD MAY NOT BE PAIRED WITH ANOTHER SHOP'S SERIES.
--
-- Same reasoning as BroadcastSend_client_same_shop_fkey, and it matters more
-- here because the row authorises a CHARGE. RLS alone does not cover it: the
-- policy asks "is this row's shopId mine?", and a row stamped with my shopId
-- carrying your seriesId answers yes. A single-column foreign key would only
-- check that the series exists somewhere.
--
-- Nothing in the application can produce such a row today - the booking route
-- creates both inside one request for one shop. But the row decides whose card
-- may be charged for whose no-show, so it is worth making unstorable rather
-- than merely unreachable.
ALTER TABLE "RecurringSeries" ADD CONSTRAINT "RecurringSeries_id_shopId_key" UNIQUE ("id", "shopId");

ALTER TABLE "CardOnFile" ADD CONSTRAINT "CardOnFile_series_same_shop_fkey"
  FOREIGN KEY ("seriesId", "shopId") REFERENCES "RecurringSeries"("id", "shopId")
  ON DELETE CASCADE ON UPDATE CASCADE;
