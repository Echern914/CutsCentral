-- PROVIDER OF THE MONTH (Eric, 2026-10-17). A shop applies with the stats it
-- chooses to put forward and a short pitch; ChairBack picks a winner, whose
-- public page then says so.
--
-- DEFAULT-DENY, like the affiliate tables: RLS enabled and FORCED, no
-- policies, no grants to the app role. These rows span every shop (the admin
-- reviews all of them) and are read by the API's owner path only, always
-- naming the shop it acts for.

CREATE TABLE "ProviderAwardApplication" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "pitch" TEXT NOT NULL,
    "credentials" TEXT,
    "stats" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderAwardApplication_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProviderAwardApplication_status_check" CHECK ("status" IN ('SUBMITTED', 'WON', 'NOT_CHOSEN')),
    CONSTRAINT "ProviderAwardApplication_month_check" CHECK ("month" ~ '^[0-9]{4}-[0-9]{2}$')
);
CREATE UNIQUE INDEX "ProviderAwardApplication_shopId_month_key" ON "ProviderAwardApplication"("shopId", "month");
CREATE INDEX "ProviderAwardApplication_month_idx" ON "ProviderAwardApplication"("month");
ALTER TABLE "ProviderAwardApplication" ADD CONSTRAINT "ProviderAwardApplication_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderAwardApplication" ADD CONSTRAINT "ProviderAwardApplication_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProviderAward" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "applicationId" TEXT,
    "month" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "winnerName" TEXT NOT NULL,
    "specialty" TEXT,
    "headline" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "stats" JSONB NOT NULL DEFAULT '[]',
    "awardedById" TEXT,
    -- The winner approves what is posted before it shows (Eric, 2026-10-17):
    -- PENDING until they do; only APPROVED is ever on their page.
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderAward_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProviderAward_month_check" CHECK ("month" ~ '^[0-9]{4}-[0-9]{2}$'),
    CONSTRAINT "ProviderAward_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'DECLINED'))
);
-- One award per shop per month; several shops may win the same month.
CREATE UNIQUE INDEX "ProviderAward_shopId_month_key" ON "ProviderAward"("shopId", "month");
CREATE INDEX "ProviderAward_month_idx" ON "ProviderAward"("month");
ALTER TABLE "ProviderAward" ADD CONSTRAINT "ProviderAward_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderAward" ADD CONSTRAINT "ProviderAward_applicationId_fkey"
    FOREIGN KEY ("applicationId") REFERENCES "ProviderAwardApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProviderAwardApplication" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProviderAwardApplication" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ProviderAward" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProviderAward" FORCE ROW LEVEL SECURITY;
