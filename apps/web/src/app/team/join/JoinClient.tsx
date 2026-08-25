"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormError } from "@/components/ui/FormError";
import { joinTeamAction } from "./actions";

const ROLE_BLURB: Record<string, string> = {
  MANAGER: "You'll be able to run the shop day to day.",
  BARBER: "You'll be set up with your own chair.",
  OWNER: "",
};

/**
 * The confirm step. Everything that could go wrong (wrong address, expired,
 * already used) was already resolved server-side before this renders, so the
 * only job here is one deliberate tap - an invitation should never be accepted
 * by a link preview fetching the page.
 *
 * When the action comes back with a `returnUrl`, the native app is waiting on
 * the other side of this browser sheet: hand off to it instead of routing into
 * the web dashboard. That URL is an https callback on our own origin carrying a
 * one-time code, never a session.
 */
export function JoinClient({
  token,
  shopName,
  role,
}: {
  token: string;
  shopName: string;
  role: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // The invitation token is this page's only authenticator, and right now it is
  // sitting in the address bar - which means browser history, the Referer of
  // anything tapped next, and any analytics pageview that fires after
  // hydration. The server component already has it; scrub the copy the browser
  // is holding.
  useEffect(() => {
    window.history.replaceState(null, "", "/team/join");
  }, []);

  function accept() {
    setError(null);
    start(async () => {
      const res = await joinTeamAction(token);
      if (res.ok) {
        if (res.returnUrl) {
          // replace(), not push(): nobody should be able to swipe back into a
          // spent invitation screen.
          window.location.replace(res.returnUrl);
          return;
        }
        router.push("/dashboard");
        router.refresh();
        return;
      }
      setError(
        res.error === "email_mismatch"
          ? "This invitation is for a different email address."
          : "This invitation is no longer valid. Ask for a new one.",
      );
    });
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
      <h1 className="font-display text-2xl text-offwhite">Join {shopName}</h1>
      <p className="mt-2 text-base text-muted">
        You&apos;ve been invited to {shopName} on ChairBack.{" "}
        {ROLE_BLURB[role] ?? ""}
      </p>
      <button
        onClick={accept}
        disabled={pending}
        className="mt-5 min-h-[44px] w-full rounded-xl bg-gold px-5 py-3 text-sm font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50"
      >
        {pending ? "Joining…" : "Accept invitation"}
      </button>
      <FormError className="mt-3">{error}</FormError>
    </div>
  );
}
