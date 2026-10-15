/* TEAM SCHEDULES: a member can let the team's owner see when they work.

   Snow's ask (2026-10-15): barbers set their own schedules, and the shop can
   see them - so the owner knows who is in, who is free now, and later routes
   walk-ins to whoever is free.

   1. "TeamLink"."shareSchedule": the member's switch, OFF by default like the
      four number switches, and reset to off whenever the link ends. What it
      shares is the member's day - working hours, time off, booked time - and
      never who is booked or for what (services/teamSchedule.ts decides).
   2. The activity feed learns two things: sharing or hiding the schedule
      ("shared"/"hid" with metric 'schedule'), and "availability" - a sharing
      member changed their hours or time off. Still never a value.

   Additive: one column with a default, and two CHECKs widened (every existing
   row still passes them). Reversible by dropping the column and restoring the
   narrower CHECKs once no row uses the new values. */

ALTER TABLE "TeamLink" ADD COLUMN "shareSchedule" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "TeamLinkEvent" DROP CONSTRAINT "TeamLinkEvent_kind_check";
ALTER TABLE "TeamLinkEvent" ADD CONSTRAINT "TeamLinkEvent_kind_check"
    CHECK ("kind" IN ('requested', 'approved', 'declined', 'removed', 'left', 'withdrew', 'shared', 'hid', 'availability'));

ALTER TABLE "TeamLinkEvent" DROP CONSTRAINT "TeamLinkEvent_metric_check";
ALTER TABLE "TeamLinkEvent" ADD CONSTRAINT "TeamLinkEvent_metric_check"
    CHECK (
      ("kind" IN ('shared', 'hid') AND "metric" IN ('cuts', 'revenue', 'clients', 'rating', 'schedule'))
      OR ("kind" NOT IN ('shared', 'hid') AND "metric" IS NULL)
    );
