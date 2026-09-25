-- "Join shop": a customer becomes a shop's client from the app.
--
-- WHY TWO COLUMNS.
--  * Shop.approveNewClients - a shop may want to OK each new client before
--    they join. requireBookingApproval can't say this: it vets every booking,
--    existing clients included; this vets a person once. Default false keeps
--    every shop open, as it is today.
--  * CustomerSavedShop.joinRequestedAt - the waiting request lives on the
--    existing account-to-shop row. It has to be told apart from a plain
--    "Add to my shops" save (which old app builds still send), because only a
--    request carries the customer's consent to give the shop their phone and
--    email, so only a request may be accepted into a client record.
ALTER TABLE "Shop" ADD COLUMN "approveNewClients" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CustomerSavedShop" ADD COLUMN "joinRequestedAt" TIMESTAMP(3);
