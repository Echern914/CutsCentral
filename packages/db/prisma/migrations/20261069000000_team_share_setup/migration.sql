-- A team member shares their setup progress with the team owner (yes/no per
-- step, never their clients or numbers). On to start - the member can hide it.
ALTER TABLE "TeamLink" ADD COLUMN "shareSetup" BOOLEAN NOT NULL DEFAULT true;

-- Showing or hiding it is a line in the owner's feed, like the other shares.
ALTER TABLE "TeamLinkEvent" DROP CONSTRAINT "TeamLinkEvent_metric_check";
ALTER TABLE "TeamLinkEvent" ADD CONSTRAINT "TeamLinkEvent_metric_check"
    CHECK (
      ("kind" IN ('shared', 'hid') AND "metric" IN ('cuts', 'revenue', 'clients', 'rating', 'schedule', 'setup'))
      OR ("kind" NOT IN ('shared', 'hid') AND "metric" IS NULL)
    );
