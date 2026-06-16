"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";

/** Client detail error boundary - a failed fetch gets a retry instead of a
 *  dead-end "Could not load client" with no way forward. */
export default function ClientDetailError({
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
        <h1 className="font-display text-2xl">Couldn&apos;t load this client</h1>
        <p className="mt-2 text-sm text-muted">This is usually temporary.</p>
        <div className="mt-6 flex justify-center gap-3">
          <button
            onClick={reset}
            className="rounded-full bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted"
          >
            Try again
          </button>
          <Link
            href="/dashboard/clients"
            className="rounded-full border border-subtle px-5 py-2.5 text-sm text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700"
          >
            All clients
          </Link>
        </div>
      </Card>
    </main>
  );
}
