/* PLATFORM NOTICES - "we know about it and we're fixing it".

   A barber asked to be told when something is broken or being worked on,
   the way other apps post a maintenance or bug notice. The platform owner
   posts one from the admin portal; it shows as a banner on every barber's
   dashboard (owners and staff) while it is live, and in the header bell.
   Platform-wide, NOT shop-scoped: there is no shopId on purpose.

   Additive only: two new tables, nothing existing is touched. */
CREATE TABLE "PlatformNotice" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "pushedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformNotice_pkey" PRIMARY KEY ("id"),
    /* CHECK-pinned vocabulary (the alter-under-traffic lesson: pin it now). */
    CONSTRAINT "PlatformNotice_severity_check" CHECK ("severity" IN ('info', 'maintenance', 'issue')),
    CONSTRAINT "PlatformNotice_window_check" CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt")
);

/* The barber read: "what is live right now" filters on the window. */
CREATE INDEX "PlatformNotice_startsAt_idx" ON "PlatformNotice"("startsAt");

/* One row per person per notice they closed. A NEW notice has no row, so it
   shows again; deleting a notice or an account takes its rows with it. */
CREATE TABLE "PlatformNoticeDismissal" (
    "noticeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformNoticeDismissal_pkey" PRIMARY KEY ("noticeId", "userId")
);

CREATE INDEX "PlatformNoticeDismissal_userId_idx" ON "PlatformNoticeDismissal"("userId");

ALTER TABLE "PlatformNoticeDismissal" ADD CONSTRAINT "PlatformNoticeDismissal_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "PlatformNotice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlatformNoticeDismissal" ADD CONSTRAINT "PlatformNoticeDismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/* 🔴 DEFAULT-DENY, the PlatformSwitch shape: revoke explicitly first (under
   ALTER DEFAULT PRIVILEGES a new table may carry grants), then RLS enabled +
   FORCED with NO policy. The tenant role can neither read nor write a notice;
   the API reads and writes both tables as the owner only (runAsOwner), and a
   barber sees a notice only through the API's own read. */
REVOKE ALL ON "PlatformNotice" FROM chairback_app;
REVOKE ALL ON "PlatformNoticeDismissal" FROM chairback_app;

ALTER TABLE "PlatformNotice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformNotice" FORCE ROW LEVEL SECURITY;
ALTER TABLE "PlatformNoticeDismissal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformNoticeDismissal" FORCE ROW LEVEL SECURITY;
