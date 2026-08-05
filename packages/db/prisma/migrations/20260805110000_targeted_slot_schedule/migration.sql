-- Targeted-slot rules learn a weekly SCHEDULE: {"0".."6": [{startMin,
-- durationMin?, price?}]} (Service.hoursWindows key convention, shop-local
-- minutes). One rule can now say "every night at 9pm" or "mornings and
-- afternoons daily" instead of one weekday x one time derived from `anchor`.
--
-- Backfill: every existing rule becomes the schedule it already meant - its
-- anchor's shop-local weekday and wall-clock minutes. anchor is a naive UTC
-- timestamp, so convert UTC -> shop-local before extracting the parts.

ALTER TABLE "TargetedSlotRule" ADD COLUMN "schedule" JSONB NOT NULL DEFAULT '{}';

UPDATE "TargetedSlotRule" r
SET "schedule" = jsonb_build_object(
  EXTRACT(dow FROM ((r."anchor" AT TIME ZONE 'UTC') AT TIME ZONE s."timezone"))::int::text,
  jsonb_build_array(
    jsonb_build_object(
      'startMin',
      EXTRACT(hour   FROM ((r."anchor" AT TIME ZONE 'UTC') AT TIME ZONE s."timezone"))::int * 60
    + EXTRACT(minute FROM ((r."anchor" AT TIME ZONE 'UTC') AT TIME ZONE s."timezone"))::int
    )
  )
)
FROM "Shop" s
WHERE s."id" = r."shopId";
