import Link from "next/link";
import { cookies } from "next/headers";
import { apiGet } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { TEAM_LINK_COOKIE, teamKeyOk } from "@/lib/teamLinkCookie";
import { BackfillPoller } from "./BackfillPoller";

// Distinct document title per route (WCAG 2.4.2) via the root %s template.
export const metadata = { title: "You're all set" };

interface ShopStatus {
  connected: boolean;
  visitCount: number;
  clientCount: number;
}

export default async function OnboardingDonePage() {
  const [res, teamsRes, retry] = await Promise.all([
    apiGet<ShopStatus>("/api/shops/me"),
    // This business's teams, from the database - not from a cookie. A brand
    // new business is only on a team (or waiting) because setup just asked.
    apiGet<{ links: { id: string; status: "PENDING" | "ACTIVE"; team: { name: string } }[] }>("/api/teams"),
    teamToRetry(),
  ]);
  const status = res.data;
  const teams = teamsRes.ok ? (teamsRes.data?.links ?? []) : [];

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5">
      {/* Light auto-refresh while backfill imports history (stops on its own) */}
      <BackfillPoller
        active={Boolean(status?.connected) && (status?.visitCount ?? 0) === 0}
      />
      <p className="text-center text-xs uppercase tracking-[0.2em] text-muted">
        Step 3 of 3
      </p>
      <h1 className="mb-2 mt-2 text-center font-display text-3xl tracking-tight">
        You&apos;re all set
      </h1>
      <Card className="mt-4 flex flex-col items-center gap-4 p-8 text-center">
        {/* role=status: the poller swaps importing → imported without a page
            navigation, so the result must be announced to screen readers. */}
        {!status?.connected ? (
          <p className="text-sm text-muted">
            No booking platform connected yet. You can connect Acuity or Square
            anytime from the Booking tab - or use ChairBack&apos;s own booking
            page instead.
          </p>
        ) : status.visitCount === 0 ? (
          <div role="status" className="flex w-full flex-col items-center gap-4">
            <div aria-hidden="true" className="h-2 w-full overflow-hidden rounded-full bg-charcoal-700">
              <div className="skeleton h-full w-1/3 rounded-full bg-gold/40" />
            </div>
            <p className="text-sm text-muted">
              Importing your appointment history… this can take a minute. New on
              Acuity? There may be nothing to import yet. Your dashboard works
              either way.
            </p>
          </div>
        ) : (
          <p role="status" className="text-sm text-emerald-soft">
            Imported {status.clientCount} clients and {status.visitCount} visits.
          </p>
        )}
        {teams.map((t) => (
          <p key={t.id} role="status" className="text-sm text-emerald-soft" data-qa="team-request-sent">
            {t.status === "ACTIVE"
              ? `You're on ${t.team.name}'s team.`
              : `Your request to join ${t.team.name}'s team is sent. They'll approve it, and nothing is shared until you choose.`}
          </p>
        ))}
        {retry ? (
          <>
            {/* Setup couldn't send the request they came for: offer it. */}
            <Link
              href={`/team/link/${retry.key}`}
              className="w-full rounded-full bg-gold-gradient px-5 py-3 text-sm font-semibold text-charcoal shadow-glow transition-all duration-200 ease-out hover:shadow-glow-lg hover:brightness-105"
            >
              Finish joining {retry.teamName}&apos;s team
            </Link>
            <Link
              href="/dashboard"
              className="w-full rounded-full border border-subtle px-5 py-3 text-sm text-offwhite transition-colors duration-200 ease-out hover:bg-charcoal-700"
            >
              Go to dashboard
            </Link>
          </>
        ) : (
          <Link
            href="/dashboard"
            className="w-full rounded-full bg-gold-gradient px-5 py-3 text-sm font-semibold text-charcoal shadow-glow transition-all duration-200 ease-out hover:shadow-glow-lg hover:brightness-105"
          >
            Go to dashboard
          </Link>
        )}
      </Card>
    </main>
  );
}

/**
 * A team this person set up their business to join, whose request didn't go
 * through (setup forgets the team once the API has it, so a cookie still here
 * means it failed). Null otherwise - including when they've since asked.
 */
async function teamToRetry(): Promise<{ key: string; teamName: string } | null> {
  const key = cookies().get(TEAM_LINK_COOKIE)?.value;
  if (!teamKeyOk(key)) return null;
  const res = await apiGet<{
    team: { name: string };
    status: "PENDING" | "ACTIVE" | null;
    ownTeam: boolean;
  }>(`/api/teams/preview?team=${encodeURIComponent(key)}`);
  if (!res.ok || !res.data || res.data.ownTeam || res.data.status) return null;
  return { key, teamName: res.data.team.name };
}
