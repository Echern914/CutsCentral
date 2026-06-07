"use client";

import { useEffect } from "react";
import { Card } from "@/components/ui/Card";

/** Dashboard error boundary - no more blank page on a failed fetch. */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
            onClick={reset}
            className="rounded-full bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal hover:bg-gold-muted"
          >
            Try again
          </button>
          <a
            href="/login"
            className="rounded-full border border-subtle px-5 py-2.5 text-sm text-muted hover:bg-charcoal-700"
          >
            Sign in again
          </a>
        </div>
      </Card>
    </main>
  );
}
