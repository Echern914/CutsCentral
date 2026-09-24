"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FlowCard, FlowSecondaryLink } from "@/components/FlowCard";
import { FormError } from "@/components/ui/FormError";
import { askToJoinAction } from "./actions";

/**
 * The one decision on this page: ask to join. Reads "Sending…" until the
 * server answers, and says "Request sent" only once it has.
 */
export function JoinTeamClient({
  team,
  teamName,
  businessName,
}: {
  team: string;
  teamName: string;
  businessName: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function ask() {
    setPending(true);
    setError(null);
    const res = await askToJoinAction(team);
    setPending(false);
    if (res.ok) {
      setSent(true);
      return;
    }
    if (res.error === "already_linked") {
      // Already asked (another tab, a double tap) or already on the team:
      // the server page knows which, so let it say.
      router.refresh();
      return;
    }
    setError(
      res.error === "team_not_found"
        ? "This team link isn't valid anymore. Ask the shop owner for a new one."
        : res.error === "own_team"
          ? "This is your own team."
          : "That didn't go through. Try again.",
    );
  }

  if (sent) {
    return (
      <FlowCard
        title="Request sent"
        tone="success"
        glyph="✓"
        actions={<FlowSecondaryLink href="/dashboard/teams">See your teams</FlowSecondaryLink>}
      >
        {teamName} will approve it. Nothing is shared until you choose what they can see.
      </FlowCard>
    );
  }

  return (
    <FlowCard
      title={`Join ${teamName}'s team`}
      actions={
        <>
          <button
            type="button"
            onClick={() => void ask()}
            disabled={pending}
            data-qa="ask-to-join"
            className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-gold px-5 py-3 text-sm font-semibold text-charcoal transition-colors duration-200 ease-out hover:bg-gold-muted disabled:opacity-50"
          >
            {pending ? "Sending…" : "Ask to join"}
          </button>
          <FormError>{error}</FormError>
        </>
      }
    >
      <p>
        You&apos;ll join with <strong className="text-offwhite">{businessName}</strong>.
      </p>
      <ul className="mt-3 space-y-1 text-left text-sm">
        <li>• Your clients, bookings and payments stay yours.</li>
        <li>• {teamName} sees nothing until you choose what to share.</li>
        <li>• You can leave anytime.</li>
      </ul>
    </FlowCard>
  );
}
