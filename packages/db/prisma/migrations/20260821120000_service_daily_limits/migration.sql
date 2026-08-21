-- Per-service, per-weekday daily booking caps.
--
-- Replaces ServiceGroup.maxPerDay, which was one number shared by every member
-- of a group and the same on every day of the week - so "three retwists on a
-- Sunday, as many fades as you like" could not be said at all.
--
-- ServiceGroup.maxPerDay is deliberately NOT dropped. It keeps the old value
-- readable if this ever needs unpicking, and it follows the precedent set when
-- hours moved off the group (ServiceGroup.hoursWindows is likewise still in the
-- schema and no longer read). Nothing reads maxPerDay after this migration.

ALTER TABLE "Service" ADD COLUMN "dailyLimits" JSONB NOT NULL DEFAULT '{}';

-- Carry each ACTIVE group's cap down onto its member services, as the same
-- number on all seven days - which is exactly what a single maxPerDay meant.
--
-- 🔴 THE `> 0` IS LOAD-BEARING. The group editor bound its input to 0 for "no
-- cap" (useState(group.maxPerDay ?? 0), then `maxPerDay <= 0 ? null`), so a 0
-- in this column means UNLIMITED, not "zero bookings allowed". Copying it
-- literally would write {"0":0,...,"6":0} and make the service permanently
-- unbookable - a silent outage on every shop that had ever opened that editor
-- and saved. Unlimited is the ABSENCE of a key, so those rows are skipped and
-- keep the default '{}'.
--
-- Inactive groups are skipped too: the engine already ignored their caps, so
-- copying them down would newly ENFORCE a limit that was doing nothing.
UPDATE "Service" s
SET "dailyLimits" = jsonb_build_object(
      '0', g."maxPerDay",
      '1', g."maxPerDay",
      '2', g."maxPerDay",
      '3', g."maxPerDay",
      '4', g."maxPerDay",
      '5', g."maxPerDay",
      '6', g."maxPerDay"
    )
FROM "ServiceGroup" g
WHERE s."serviceGroupId" = g."id"
  AND g."active" = true
  AND g."maxPerDay" IS NOT NULL
  AND g."maxPerDay" > 0;
