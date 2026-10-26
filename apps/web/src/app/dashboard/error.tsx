"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";

/** Dashboard error boundary - no more blank page on a failed fetch. */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // 🔴 reset() ALONE re-renders the same failed result: after a server error
  // ("Failed to load your shop") nothing is fetched again, so "Try again" did
  // nothing. Refresh first (re-runs the server render), then reset.
  const router = useRouter();
  const [retrying, startRetry] = useTransition();
  const tryAgain = () =>
    startRetry(() => {
      router.refresh();
      reset();
    });
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col justify-center px-5">
      <Card className="p-8 text-center">
        <h1 className="font-display text-2xl">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted">
          We couldn&apos;t load your dashboard. This is usually temporary.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button
            type="button"
            onClick={tryAgain}
            disabled={retrying}
            className="rounded-full bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-60"
          >
            {retrying ? "Trying again" : "Try again"}
          </button>
          <a
            href="/login"
            className="rounded-full border border-subtle px-5 py-2.5 text-sm text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700"
          >
            Sign in again
          </a>
        </div>
      </Card>
    </main>
  );
}
