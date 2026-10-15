import type { Metadata } from "next";
import { apiGet } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { getVocabulary } from "@/lib/vocab";
import { TeamClient } from "./TeamClient";
import { IndependentTeam, type TeamLinksData } from "./IndependentTeam";
import type { TeamActivityItem } from "@/lib/teamNumbers";
import type { TeamScheduleData } from "@/lib/teamSchedule";
import type { TeamDeskData } from "@/lib/teamWalkIns";

export const metadata: Metadata = { title: "Team" };

export type ShopRole = "OWNER" | "MANAGER" | "BARBER";

export interface TeamMember {
  id: string;
  role: ShopRole;
  /** The chair this person works, when their seat is linked to one. */
  staffId: string | null;
  joinedAt: string;
  user: { id: string; name: string; email: string; avatarUrl: string | null };
}

export interface TeamInvite {
  id: string;
  email: string;
  role: ShopRole;
  staffId: string | null;
  expiresAt: string;
}

export interface TeamData {
  /** The viewer's own role — drives which controls render at all. */
  role: ShopRole;
  ownerUserId: string;
  members: TeamMember[];
  invites: TeamInvite[];
  staff: { id: string; name: string }[];
  /** Invitations need transactional email; false hides the invite form. */
  inviteAvailable: boolean;
}

export default async function TeamPage() {
  // `getVocabulary` reads getMe(), which is React-cached per render, so asking
  // for it here costs nothing extra. Passed DOWN as a prop rather than via a
  // context provider - a provider would be a second source of truth.
  // The independent-team card is owner-only: for anyone else /links is a 403
  // and the card isn't rendered.
  const [res, vocab, linksRes, activityRes, scheduleRes, deskRes] = await Promise.all([
    apiGet<TeamData>("/api/team"),
    getVocabulary(),
    apiGet<TeamLinksData>("/api/team/links"),
    // Owner-only like /links: anyone else's 403 just means no feed.
    apiGet<{ items: TeamActivityItem[] }>("/api/team/activity"),
    // Owner-only too: today's schedules. A failed read just means no section.
    apiGet<TeamScheduleData>("/api/team/schedule"),
    // The front desk's line; `available: false` while Walk-In Mode is off.
    apiGet<TeamDeskData>("/api/team/walk-ins"),
  ]);
  const data = res.data;
  const links = linksRes.ok ? linksRes.data : null;
  const activity = activityRes.ok ? (activityRes.data?.items ?? null) : null;
  const schedule = scheduleRes.ok ? (scheduleRes.data ?? null) : null;
  const desk = deskRes.ok ? (deskRes.data ?? null) : null;

  if (!data) {
    return (
      <main className="mx-auto w-full max-w-4xl px-5 py-8">
        <h1 className="font-display text-2xl">Team</h1>
        <p className="mt-3 text-sm text-muted">
          Couldn&apos;t load your team right now. Refresh to try again.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8">
      <TeamClient initial={data} vocab={vocab}>
        {links && (
          <IndependentTeam
            initial={links}
            initialActivity={activity}
            initialSchedule={schedule}
            initialDesk={desk}
            vocab={vocab}
          />
        )}
        {/* Only the owner has that card, so for them a failed read is said
            out loud - never a card that silently isn't there. */}
        {!links && data.role === "OWNER" && (
          <Card className="px-5 py-5">
            <p className="text-sm text-muted" data-qa="team-links-failed">
              Couldn&apos;t load your team link and join requests. Refresh to try again.
            </p>
          </Card>
        )}
      </TeamClient>
    </main>
  );
}
