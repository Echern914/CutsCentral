/* MENTORSHIP ON A TEAM: a mentor sees a student's numbers - only what the
   student shares with that mentor.

   Snow's mentorship ask (2026-10-15), the numbers half. Photo feedback stays
   in the team's own chat; nothing here stores a photo.

   1. "TeamMentorship": one row per pairing. The team's owner creates it; both
      sides are members (TeamLinks) of that team, and a member can't mentor
      themselves (CHECK). Cascades with either link.
   2. "status" CHECK-pinned to ACTIVE | ENDED. One ACTIVE pairing per mentor
      and student at a time (partial unique index); an ended one stays as the
      record and a new one can start later.
   3. The four share switches, all off by default - set by the STUDENT only,
      separately from what they share with the team's owner.
   4. Default-deny, the TeamLink shape: it joins two businesses, so the tenant
      role gets nothing and RLS is enabled + forced with no policy.

   Additive: a new table only. Reversible by dropping it. */

CREATE TABLE "TeamMentorship" (
    "id" TEXT NOT NULL,
    "teamShopId" TEXT NOT NULL,
    "mentorLinkId" TEXT NOT NULL,
    "studentLinkId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "shareCuts" BOOLEAN NOT NULL DEFAULT false,
    "shareRevenue" BOOLEAN NOT NULL DEFAULT false,
    "shareClients" BOOLEAN NOT NULL DEFAULT false,
    "shareRating" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamMentorship_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TeamMentorship_teamShopId_status_idx" ON "TeamMentorship"("teamShopId", "status");
CREATE INDEX "TeamMentorship_mentorLinkId_status_idx" ON "TeamMentorship"("mentorLinkId", "status");
CREATE INDEX "TeamMentorship_studentLinkId_status_idx" ON "TeamMentorship"("studentLinkId", "status");

-- One live pairing per mentor and student.
CREATE UNIQUE INDEX "TeamMentorship_one_active_pair"
    ON "TeamMentorship"("mentorLinkId", "studentLinkId") WHERE "status" = 'ACTIVE';

ALTER TABLE "TeamMentorship" ADD CONSTRAINT "TeamMentorship_mentorLinkId_fkey"
    FOREIGN KEY ("mentorLinkId") REFERENCES "TeamLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamMentorship" ADD CONSTRAINT "TeamMentorship_studentLinkId_fkey"
    FOREIGN KEY ("studentLinkId") REFERENCES "TeamLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamMentorship" ADD CONSTRAINT "TeamMentorship_status_check"
    CHECK ("status" IN ('ACTIVE', 'ENDED'));
ALTER TABLE "TeamMentorship" ADD CONSTRAINT "TeamMentorship_not_self_check"
    CHECK ("mentorLinkId" <> "studentLinkId");

REVOKE ALL ON "TeamMentorship" FROM chairback_app;
ALTER TABLE "TeamMentorship" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeamMentorship" FORCE ROW LEVEL SECURITY;
