"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { UpgradeOnWebLink } from "@/components/UpgradeOnWebLink";

/**
 * What the Insights page shows when its main read fails. It used to be one
 * line, "Could not load your insights.", for every failure, so an owner's
 * screenshot couldn't tell a lapsed plan from a timeout from a server error,
 * and there was nothing to tap but the tab bar.
 *
 * `status` is the API's HTTP status, or 0 when the request never completed
 * (the 12-second timeout in lib/api.ts, or the network).
 */
export interface LoadErrorCopy {
  title: string;
  body: string;
  /** Whether trying again could help. A plan or a seat won't change by retrying. */
  retry: boolean;
  /** A plan link instead of a retry. */
  plan: boolean;
}

export function insightsLoadErrorCopy(status: number): LoadErrorCopy {
  if (status === 402) {
    return {
      title: "Insights is paused",
      body: "Your plan has ended. Nothing is lost: your numbers come back as soon as a plan is active again.",
      retry: false,
      plan: true,
    };
  }
  if (status === 403) {
    return {
      title: "Insights is for owners and managers",
      body: "Your seat on this business doesn't include Insights. Ask the owner if you need these numbers.",
      retry: false,
      plan: false,
    };
  }
  if (status === 429) {
    return {
      title: "Too many requests at once",
      body: "Give it a minute, then try again.",
      retry: true,
      plan: false,
    };
  }
  if (status === 0) {
    return {
      title: "Insights took too long to load",
      body: "Your numbers are safe. A slow connection or a busy moment can do this, so try again.",
      retry: true,
      plan: false,
    };
  }
  return {
    title: "Insights didn't load",
    body: `Something went wrong on our side (error ${status}). Try again, and if it keeps happening, tell us.`,
    retry: true,
    plan: false,
  };
}

export function InsightsLoadError({ status }: { status: number }) {
  const copy = insightsLoadErrorCopy(status);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // A ref, not just `pending`: a second tap can land before React re-renders
  // the button as disabled.
  const busy = useRef(false);
  const [tries, setTries] = useState(0);

  // The refresh is done once the transition settles; only then can a tap count.
  useEffect(() => {
    if (!pending) busy.current = false;
  }, [pending]);

  function tryAgain() {
    if (busy.current) return;
    busy.current = true;
    setTries((n) => n + 1);
    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8">
      <h1 className="font-display text-3xl tracking-tight">Insights</h1>
      <div role="alert" className="mt-6 rounded-2xl border border-subtle px-5 py-4">
        <p className="font-semibold text-offwhite">{copy.title}</p>
        <p className="mt-1 text-sm text-muted">{copy.body}</p>
        {copy.retry && (
          <button
            type="button"
            onClick={tryAgain}
            disabled={pending}
            className="mt-4 inline-flex min-h-[44px] items-center rounded-full border border-gold/50 px-5 text-sm font-semibold text-gold transition-colors duration-150 ease-out hover:bg-gold/10 disabled:opacity-50"
          >
            {pending ? "Trying again…" : "Try again"}
          </button>
        )}
        {copy.retry && tries > 0 && !pending && (
          <p className="mt-2 text-xs text-muted">Still not loading. If it stays this way, tell us and we&apos;ll look.</p>
        )}
        {copy.plan && <UpgradeOnWebLink wrapClassName="mt-4">See your plan &rarr;</UpgradeOnWebLink>}
      </div>
    </main>
  );
}
