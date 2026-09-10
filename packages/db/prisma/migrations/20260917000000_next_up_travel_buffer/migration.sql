-- Travel-aware "next up". Additive: one column, default 0, which is exactly
-- today's behaviour for every existing barber.
--
-- The alert fires a flat number of minutes before a booking STARTS. For a shop
-- whose customers come to them that is right. For a mobile trade it is not:
-- being told about a job thirty minutes out that is forty minutes away is
-- worse than not being told, because it reads as "you have time" when the
-- barber is already late.
--
-- The buffer is an allowance the barber sets, not a route anyone computed --
-- there is no maps integration, no origin to measure from and no live traffic,
-- so a "real" travel time would be a guess presented as a fact.
ALTER TABLE "BarberNotifyPref"
  ADD COLUMN "travelBufferMin" INTEGER NOT NULL DEFAULT 0;
