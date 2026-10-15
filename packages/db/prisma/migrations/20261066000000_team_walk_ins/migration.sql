/* TEAM WALK-INS: one front desk for a shop of independent businesses.

   Snow's ask (2026-10-15): an online walk-in line at the shop, routed to the
   barbers who are free - every barber being their own business.

   The front desk is the TEAM shop's kiosk. A customer checks in there, picks a
   barber (or "next available"), and joins THAT barber's own line - the entry
   lives in the member's shop, on the member's books, exactly like a walk-in
   who used the member's own kiosk. Nothing about a member's line moves into
   the team's shop.

   1. "TeamLink"."takeTeamWalkIns": the MEMBER's switch, off by default, reset
      when the link ends. Off = the front desk never offers them.
   2. "WalkInEntry"."viaTeamShopId": which front desk sent this entry (null
      for every entry that came any other way). It lets the team's owner see
      the desk's line across members, and nothing else of anyone's line.
      SET NULL if the team shop goes: the entry stays in the member's line.
   3. One live spot per phone per front desk (partial unique, the same active
      predicate as WalkInEntry_one_active_per_phone): checking in again at the
      desk - for the same barber or another - finds the spot already held.
   4. The team feed learns that a member started or stopped taking front-desk
      walk-ins.

   Additive: two nullable/defaulted columns, two indexes, a widened CHECK.
   Reversible by dropping them once no row uses the new event kinds. */

ALTER TABLE "TeamLink" ADD COLUMN "takeTeamWalkIns" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "WalkInEntry" ADD COLUMN "viaTeamShopId" TEXT;
ALTER TABLE "WalkInEntry" ADD CONSTRAINT "WalkInEntry_viaTeamShopId_fkey"
    FOREIGN KEY ("viaTeamShopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "WalkInEntry_viaTeamShopId_status_idx" ON "WalkInEntry"("viaTeamShopId", "status");
CREATE UNIQUE INDEX "WalkInEntry_one_active_per_phone_per_desk"
    ON "WalkInEntry"("viaTeamShopId", "phone")
    WHERE "status" IN ('WAITING', 'ASSIGNED', 'READY', 'IN_SERVICE')
      AND "phone" IS NOT NULL
      AND "viaTeamShopId" IS NOT NULL;

ALTER TABLE "TeamLinkEvent" DROP CONSTRAINT "TeamLinkEvent_kind_check";
ALTER TABLE "TeamLinkEvent" ADD CONSTRAINT "TeamLinkEvent_kind_check"
    CHECK ("kind" IN ('requested', 'approved', 'declined', 'removed', 'left', 'withdrew', 'shared', 'hid', 'availability', 'walk_ins_on', 'walk_ins_off'));
