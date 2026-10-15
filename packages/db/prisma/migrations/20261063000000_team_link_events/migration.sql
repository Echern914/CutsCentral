/* TEAM ACTIVITY: what happened on each team link, for the owner's feed.

   Snow's Team Logistics ask (2026-10-15): the owner sees who asked to join,
   who was approved, declined, removed or left, and when a barber shared or
   hid one of their numbers. Booth rent payments come from BoothRentPayment,
   the one ledger - not copied here.

   1. "TeamLinkEvent": append-only, one row per thing that happened. Cascades
      with its link, like rent.
   2. "kind" CHECK-pinned to the eight things that can happen; "metric" set
      exactly for shared/hid, and only to one of the four shareable numbers.
      🔴 Never a VALUE: a sharing event names which number, never what it was.
   3. Default-deny, the TeamLink shape: it belongs to two shops, so the tenant
      role gets nothing and RLS is enabled + forced with no policy. Only the
      API's owner path reads or writes it.

   Additive: a new table only. Existing links simply have no history before
   this deploy. Reversible by dropping the table. */

CREATE TABLE "TeamLinkEvent" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "teamShopId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "metric" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamLinkEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TeamLinkEvent_teamShopId_createdAt_idx" ON "TeamLinkEvent"("teamShopId", "createdAt");
CREATE INDEX "TeamLinkEvent_linkId_idx" ON "TeamLinkEvent"("linkId");

ALTER TABLE "TeamLinkEvent" ADD CONSTRAINT "TeamLinkEvent_linkId_fkey"
    FOREIGN KEY ("linkId") REFERENCES "TeamLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamLinkEvent" ADD CONSTRAINT "TeamLinkEvent_kind_check"
    CHECK ("kind" IN ('requested', 'approved', 'declined', 'removed', 'left', 'withdrew', 'shared', 'hid'));

ALTER TABLE "TeamLinkEvent" ADD CONSTRAINT "TeamLinkEvent_metric_check"
    CHECK (
      ("kind" IN ('shared', 'hid') AND "metric" IN ('cuts', 'revenue', 'clients', 'rating'))
      OR ("kind" NOT IN ('shared', 'hid') AND "metric" IS NULL)
    );

REVOKE ALL ON "TeamLinkEvent" FROM chairback_app;
ALTER TABLE "TeamLinkEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeamLinkEvent" FORCE ROW LEVEL SECURITY;
