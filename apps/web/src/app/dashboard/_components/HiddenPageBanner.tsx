"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { savePageAction } from "../site/actions";

/**
 * Shown on the dashboard home while the shop's page is hidden. A hidden page
 * also stops online booking, and nothing said so anywhere: an owner found out
 * from a client's screenshot of "That page doesn't exist". One tap here turns
 * the page back on.
 */
export function hiddenPageBody(booksHere: boolean): string {
  return booksHere
    ? "Clients can't book online, and your links tell them you aren't taking online bookings."
    : "Clients who open your link see that your page isn't available.";
}

const TURN_ON_FAILED = "Couldn't turn it on. Check your connection and try again.";

export function HiddenPageBanner({ booksHere }: { booksHere: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // A ref, not just `pending`: a second tap can land before React re-renders
  // the button as disabled. It clears when the save itself settles, never off
  // `pending` - that stays true for the whole save only under Next's React.
  const busy = useRef(false);

  if (done) return null;

  function turnOn() {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const r = await savePageAction({ publicPageEnabled: true });
        if (r.ok) {
          setDone(true);
          router.refresh();
        } else {
          setError(r.error ?? TURN_ON_FAILED);
        }
      } catch {
        // A server action rejects outright when the connection drops.
        setError(TURN_ON_FAILED);
      } finally {
        busy.current = false;
      }
    });
  }

  return (
    <div
      role="region"
      aria-label="Your page is hidden"
      className="mb-6 flex flex-col gap-3 rounded-2xl border border-gold/40 bg-gold/5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <p className="text-sm font-semibold text-gold">Your page is hidden</p>
        <p className="mt-0.5 text-xs text-muted">{hiddenPageBody(booksHere)}</p>
        {error && (
          <p className="mt-1 text-xs text-danger-soft" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={turnOn}
          disabled={pending}
          className="min-h-[44px] rounded-full bg-gold px-5 text-sm font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-60"
        >
          {pending ? "Turning it on…" : "Turn it back on"}
        </button>
        <Link
          href="/dashboard/site"
          className="inline-flex min-h-[44px] items-center rounded-full border border-subtle px-5 text-sm text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
        >
          Page settings
        </Link>
      </div>
    </div>
  );
}
