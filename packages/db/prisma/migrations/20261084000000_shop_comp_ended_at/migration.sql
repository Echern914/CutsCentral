-- COMP ENDED: when an operator last switched a shop's complimentary access off.
--
-- Additive and nullable. NULL = never un-comped (or comped again since).
-- Read by GET /api/billing to tell a lapsed shop WHY it lapsed: a comp that
-- ended must not be told its "trial has ended".

ALTER TABLE "Shop" ADD COLUMN "compEndedAt" TIMESTAMP(3);
