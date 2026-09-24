import type { Metadata } from "next";
import { apiGet } from "@/lib/api";
import { getVocabulary } from "@/lib/vocab";
import { TeamClient } from "./TeamClient";
import { IndependentTeam, type TeamLinksData } from "./IndependentTeam";

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
  // and the card simply isn't rendered.
  const [res, vocab, linksRes] = await Promise.all([
    apiGet<TeamData>("/api/team"),
    getVocabulary(),
    apiGet<TeamLinksData>("/api/team/links"),
  ]);
  const data = res.data;
  const links = linksRes.ok ? linksRes.data : null;

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
        {links && <IndependentTeam initial={links} vocab={vocab} />}
      </TeamClient>
    </main>
  );
}
