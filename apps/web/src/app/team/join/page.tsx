import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MOBILE_APP } from "@chairback/config/constants";
import { apiGet } from "@/lib/api";
import { getMe } from "@/lib/me";
import { isMobileHandoffFlow } from "@/lib/authNext";
import { FlowCard, FlowPrimaryLink, FlowSecondaryLink } from "@/components/FlowCard";
import { JoinClient } from "./JoinClient";

export const metadata: Metadata = {
  title: "Join a team",
  robots: { index: false },
  // The URL carries the invitation token, which is this page's only
  // authenticator. Nothing the barber taps from here may leak it in a Referer.
  referrer: "no-referrer",
};

interface InvitePreview {
  shopName: string;
  role: "OWNER" | "MANAGER" | "BARBER";
  email: string;
  emailMatches: boolean;
}

/**
 * Accepting a team invitation.
 *
 * The link lands here from the invitation email, or from the app's "Join your
 * shop" flow by way of /auth/mobile/start. The token is only ever read by the
 * API (we hold the sha256), so this page's whole job is: make sure the
 * recipient is signed in AS THE INVITED ADDRESS, show them what they're
 * accepting, and let them confirm.
 *
 * Every dead-end below has to work for someone standing in a barbershop with
 * one hand on their phone, so each names what happened and who can fix it -
 * and, when the app is waiting, offers the way back to it.
 */
export default async function JoinPage({
  searchParams,
}: {
  searchParams: { token?: string };
}) {
  const token = searchParams.token;
  const fromApp = isMobileHandoffFlow();

  if (!token) {
    return (
      <FlowCard title="This link is incomplete" tone="problem" glyph="!">
        Ask whoever invited you to send it again.
      </FlowCard>
    );
  }

  // Not signed in? Send them to sign in and come straight back here. An
  // invitation is often someone's FIRST contact with ChairBack, so the login
  // page offers sign-up too and the token survives the round trip via ?next=
  // (validated against an allowlist in the auth actions - it is the one
  // destination signup is allowed to resume).
  const me = await getMe();
  if (!me.ok || !me.data) {
    redirect(`/login?next=${encodeURIComponent(`/team/join?token=${token}`)}`);
  }

  const res = await apiGet<InvitePreview>(
    `/api/team/join/preview?token=${encodeURIComponent(token)}`,
  );

  if (!res.ok || !res.data) {
    // The API tells us WHY only when the signed-in address matches the invited
    // one - so a stranger holding a guessed token still learns nothing.
    return <InviteGone reason={res.reason} fromApp={fromApp} />;
  }

  const invite = res.data;
  if (!invite.emailMatches) {
    return (
      <FlowCard title="Signed in as the wrong account" tone="problem" glyph="!">
        This invitation was sent to{" "}
        <strong className="text-offwhite">{invite.email}</strong>, but
        you&apos;re signed in as{" "}
        <strong className="text-offwhite">{me.data.email}</strong>. Sign out,
        sign back in with the invited address, then open the link again.
        <span className="mt-6 block">
          <FlowSecondaryLink href="/dashboard/account">
            Go to your account
          </FlowSecondaryLink>
        </span>
      </FlowCard>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-5 py-10">
      <JoinClient token={token} shopName={invite.shopName} role={invite.role} />
    </main>
  );
}

/**
 * The three ways an invitation stops working. Each is somebody else's fix, so
 * each says whose - a barber who reads "not valid" and nothing else will
 * usually just close the app.
 */
function InviteGone({ reason, fromApp }: { reason?: string; fromApp: boolean }) {
  const COPY: Record<string, { title: string; body: string }> = {
    expired: {
      title: "This invitation expired",
      body: "Invitations last seven days. Ask the shop owner to send a new one - it takes them a few seconds.",
    },
    revoked: {
      title: "This invitation was withdrawn",
      body: "The shop owner cancelled it. If that's a surprise, check with them and they can send another.",
    },
    used: {
      title: "This invitation was already used",
      body: "If that was you, you're already on the team - sign in and you'll see the shop.",
    },
  };
  const copy = reason ? COPY[reason] : undefined;

  return (
    <FlowCard
      title={copy?.title ?? "This invitation isn't valid"}
      tone="problem"
      glyph="!"
      actions={
        fromApp ? (
          <FlowPrimaryLink href={`${MOBILE_APP.scheme}://`}>
            Back to ChairBack
          </FlowPrimaryLink>
        ) : undefined
      }
    >
      {copy?.body ??
        "It may have been used already, withdrawn, or expired. Ask the shop owner to send a new one."}
    </FlowCard>
  );
}
