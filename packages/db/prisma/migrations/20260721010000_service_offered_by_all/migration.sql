-- "Offered by every barber" as a live intent rather than a creation-time
-- snapshot. When true, the ServiceStaff join is kept materialized to every
-- currently-active staff member, so a barber added AFTER the service was created
-- is auto-linked (write paths maintain this; read paths still consult the join).
-- Default false so every existing service keeps its exact current offering set -
-- this changes no behavior until a service is explicitly saved as "all".
ALTER TABLE "Service" ADD COLUMN "offeredByAll" BOOLEAN NOT NULL DEFAULT false;
