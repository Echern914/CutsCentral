import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { getMe } from "@/lib/me";
import { teamKeyOk } from "@/lib/teamLinkCookie";
import { FlowCard, FlowPrimaryLink, FlowSecondaryLink } from "@/components/FlowCard";
import { JoinTeamClient } from "./JoinTeamClient";
import { startBusinessAction } from "./actions";

export const metadata: Metadata = {
  title: "Join a team",
  robots: { index: false },
};

interface Preview {
  team: { name: string };
  ownTeam: boolean;
  business: { name: string } | null;
  status: "PENDING" | "ACTIVE" | null;
}

/**
 * A shop's team link (independent barbers, booth-rent shops). The owner texts
 * it; the barber opens it, signs in, and asks to join WITH THEIR OWN BUSINESS.
 *
 * Every state is one card with one obvious next step, because this is read on
 * a phone by someone mid-task: not signed in, no business yet, already asked,
 * already on the team, their own link, or a link that doesn't work.
 */
export default async function TeamLinkPage({ params }: { params: { team: string } }) {
  const key = params.team;
  if (!teamKeyOk(key)) return <InvalidLink />;

  const me = await getMe();
  if (!me.ok || !me.data) {
    redirect(`/login?next=${encodeURIComponent(`/team/link/${key}`)}`);
  }

  const res = await apiGet<Preview>(`/api/teams/preview?team=${encodeURIComponent(key)}`);
  // Only "no such team" means the link is bad. A blip (a deploy, a timeout)
  // says try again - otherwise a working link gets thrown away.
  if (res.status === 404 || res.status === 400) return <InvalidLink />;
  if (!res.ok || !res.data) return <TryAgain path={`/team/link/${key}`} />;
  const p = res.data;

  if (p.ownTeam) {
    return (
      <FlowCard
        title="This is your team link"
        actions={<FlowPrimaryLink href="/dashboard/team">Go to your team</FlowPrimaryLink>}
      >
        Send it to the people you want on {p.team.name}&apos;s team. You&apos;ll approve each
        one on your Team page.
      </FlowCard>
    );
  }

  if (p.status === "ACTIVE") {
    return (
      <FlowCard
        title={`You're on ${p.team.name}'s team`}
        tone="success"
        glyph="✓"
        actions={<FlowPrimaryLink href="/dashboard/teams">Choose what they see</FlowPrimaryLink>}
      >
        Your business stays yours. They only see what you share.
      </FlowCard>
    );
  }

  if (p.status === "PENDING") {
    return (
      <FlowCard
        title="Request sent"
        tone="success"
        glyph="✓"
        actions={<FlowSecondaryLink href="/dashboard/teams">See your teams</FlowSecondaryLink>}
      >
        {p.team.name} will approve it. Nothing is shared until you choose what they can see.
      </FlowCard>
    );
  }

  if (!p.business) {
    return (
      <FlowCard
        title="First, set up your business"
        actions={
          <form action={startBusinessAction}>
            <input type="hidden" name="team" value={key} />
            <button
              type="submit"
              className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-gold px-5 py-3 text-sm font-semibold text-charcoal transition-colors duration-200 ease-out hover:bg-gold-muted"
            >
              Set up my business
            </button>
          </form>
        }
        footnote={`Your request goes to ${p.team.name} as soon as your business is set up.`}
      >
        You join {p.team.name}&apos;s team with your own business on ChairBack. It&apos;s where your
        clients, bookings and payments live, and it stays yours if you ever leave.
      </FlowCard>
    );
  }

  return <JoinTeamClient team={key} teamName={p.team.name} businessName={p.business.name} />;
}

function TryAgain({ path }: { path: string }) {
  return (
    <FlowCard
      title="Couldn't open this team link"
      tone="problem"
      glyph="!"
      actions={<FlowPrimaryLink href={path}>Try again</FlowPrimaryLink>}
    >
      Something went wrong on our side. Try again in a moment.
    </FlowCard>
  );
}

function InvalidLink() {
  return (
    <FlowCard title="This team link isn't valid" tone="problem" glyph="!">
      Ask the shop owner to send it again.
    </FlowCard>
  );
}
