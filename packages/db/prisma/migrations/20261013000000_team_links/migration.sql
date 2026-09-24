-- Independent businesses linked to a shop's team (booth-rent shops).
--
-- WHY A NEW TABLE. A team seat (ShopMember) lets a person work INSIDE a shop,
-- so their clients and bookings become the shop's - the arrangement booth
-- renters are leaving. Nothing relates two businesses today. A TeamLink does
-- exactly that and nothing more: the member's clients, bookings, payments and
-- reviews stay in their own shop, and the link records only whether they are
-- on the team and which numbers the team's owner may see.

-- CreateEnum
CREATE TYPE "TeamLinkStatus" AS ENUM ('PENDING', 'ACTIVE', 'ENDED');

-- CreateTable
CREATE TABLE "TeamLink" (
    "id" TEXT NOT NULL,
    "teamShopId" TEXT NOT NULL,
    "memberShopId" TEXT NOT NULL,
    "status" "TeamLinkStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "shareCuts" BOOLEAN NOT NULL DEFAULT false,
    "shareRevenue" BOOLEAN NOT NULL DEFAULT false,
    "shareClients" BOOLEAN NOT NULL DEFAULT false,
    "shareRating" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeamLink_memberShopId_idx" ON "TeamLink"("memberShopId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamLink_teamShopId_memberShopId_key" ON "TeamLink"("teamShopId", "memberShopId");

-- AddForeignKey
ALTER TABLE "TeamLink" ADD CONSTRAINT "TeamLink_teamShopId_fkey" FOREIGN KEY ("teamShopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamLink" ADD CONSTRAINT "TeamLink_memberShopId_fkey" FOREIGN KEY ("memberShopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A business can't be on its own team.
ALTER TABLE "TeamLink"
    ADD CONSTRAINT "TeamLink_not_self_check"
    CHECK ("teamShopId" <> "memberShopId");

-- 🔴 DEFAULT-DENY, the PlatformSwitch shape. A link belongs to TWO shops, so
-- the one-shop tenant policy cannot describe it: the tenant role gets nothing
-- (revoked explicitly first - under ALTER DEFAULT PRIVILEGES a new table may
-- carry grants), and RLS is enabled + FORCED with no policy. Only the API's
-- owner path reads or writes it, always naming the shop the caller acts for.
REVOKE ALL ON "TeamLink" FROM chairback_app;
ALTER TABLE "TeamLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeamLink" FORCE ROW LEVEL SECURITY;
