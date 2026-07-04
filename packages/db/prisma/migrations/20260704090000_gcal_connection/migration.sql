-- Google Calendar bridge connection (mirrors SquareConnection). One per shop;
-- holds the encrypted OAuth tokens + the incremental-sync cursor. Feeds Visits
-- from platforms with no public API (Booksy / GlossGenius / ...) via their
-- Google Calendar sync.

-- CreateTable
CREATE TABLE "GoogleCalendarConnection" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "googleEmail" TEXT,
    "calendarId" TEXT NOT NULL DEFAULT 'primary',
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'openid email https://www.googleapis.com/auth/calendar.events.readonly',
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "syncToken" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleCalendarConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoogleCalendarConnection_shopId_key" ON "GoogleCalendarConnection"("shopId");

-- AddForeignKey
ALTER TABLE "GoogleCalendarConnection" ADD CONSTRAINT "GoogleCalendarConnection_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: GoogleCalendarConnection is a SECRETS table looked up by the trusted
-- server (by shopId), NOT a per-shop tenant table. So mirror AcuityConnection /
-- SquareConnection (the 20260609000000_rls_lockdown_non_tenant_tables pattern):
-- ENABLE RLS only — NO FORCE, NO policy, NO GRANT to chairback_app. The app
-- connects as the table OWNER (postgres), which bypasses non-forced RLS and
-- keeps full access; the Supabase data-API roles get default-deny.
ALTER TABLE "GoogleCalendarConnection" ENABLE ROW LEVEL SECURITY;
