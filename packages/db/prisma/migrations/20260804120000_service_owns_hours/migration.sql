-- Available hours move from the service GROUP onto the SERVICE.
--
-- Until now engines/slots.ts read `group.hoursWindows` INSTEAD of the member
-- service's own whenever the service belonged to an ACTIVE group. So for those
-- services the group's map was the live restriction and the service's own map
-- was dead config the engine never looked at.
--
-- Copy the live value down so that switching the engine to always read
-- Service.hoursWindows leaves every existing shop's bookable availability
-- byte-for-byte identical.
--
-- OVERWRITE, do not merge: an active group's map won outright, INCLUDING when
-- it was '{}' (which means "no restriction" and discarded whatever the service
-- had). Merging, or skipping services that already had their own windows, would
-- resurrect ignored config as a real restriction and silently change what
-- customers can book.
UPDATE "Service" s
SET "hoursWindows" = g."hoursWindows"
FROM "ServiceGroup" g
WHERE s."serviceGroupId" = g."id"
  AND g."active" = true
  AND s."hoursWindows" IS DISTINCT FROM g."hoursWindows";

-- Services in an INACTIVE group are deliberately untouched: the engine already
-- ignored such a group and used the service's own map, so they are already
-- correct.
--
-- ServiceGroup."hoursWindows" is intentionally LEFT IN PLACE and left populated.
-- It is no longer read by anything. Keeping the column and its data makes this
-- change trivially revertible: restoring the old engine restores the old
-- behavior exactly, because the values it would read are still the ones that
-- were just copied down.
