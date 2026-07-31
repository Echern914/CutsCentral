import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { getMe } from "@/lib/me";
import { JoinClient } from "./JoinClient";

export const metadata: Metadata = { title: "Join a team", robots: { index: false } };

interface InvitePreview {
  shopName: string;
  role: "OWNER" | "MANAGER" | "BARBER";
  email: string;
  emailMatches: boolean;
}

/**
 * Accepting a team invitation.
 *
 * The link lands here from the invite email. The token is only ever read by
 * the API (we hold the sha256), so this page's whole job is: make sure the
 * recipient is signed in AS THE INVITED ADDRESS, show them what they're
 * accepting, and let them confirm.
 */
export default async function JoinPage({
  searchParams,
}: {
  searchParams: { token?: string };
}) {
  const token = searchParams.token;
  if (!token) {
    return (
      <Shell title="This link is incomplete">
        Ask whoever invited you to send it again.
      </Shell>
    );
  }

  // Not signed in? Send them to sign in and come straight back here. An invite
  // is often someone's FIRST contact with ChairBack, so the login page offers
  // sign-up too and the token survives the round trip via ?next=.
  const me = await getMe();
  if (!me.ok || !me.data) {
    redirect(`/login?next=${encodeURIComponent(`/team/join?token=${token}`)}`);
  }

  const res = await apiGet<InvitePreview>(
    `/api/team/join/preview?token=${encodeURIComponent(token)}`,
  );
  if (!res.ok || !res.data) {
    return (
      <Shell title="This invitation isn't valid">
        It may have been used already, revoked, or expired. Ask the shop owner
        to send a new one.
      </Shell>
    );
  }

  const invite = res.data;
  if (!invite.emailMatches) {
    return (
      <Shell title="This invitation is for a different address">
        <>
          It was sent to <strong className="text-offwhite">{invite.email}</strong>,
          but you&apos;re signed in as{" "}
          <strong className="text-offwhite">{me.data.email}</strong>. Sign out,
          sign back in with the invited address, then open the link again.
          <span className="mt-4 block">
            <Link
              href="/dashboard/account"
              className="text-gold underline-offset-2 hover:underline"
            >
              Go to your account
            </Link>
          </span>
        </>
      </Shell>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10">
      <JoinClient
        token={token}
        shopName={invite.shopName}
        role={invite.role}
      />
    </main>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10">
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
        <h1 className="font-display text-xl text-offwhite">{title}</h1>
        <p className="mt-2 text-sm text-muted">{children}</p>
      </div>
    </main>
  );
}
