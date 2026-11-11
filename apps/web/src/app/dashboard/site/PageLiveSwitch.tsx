"use client";

import { useRef, useState, useTransition } from "react";
import { cn } from "@/lib/cn";
import { savePageAction } from "./actions";

/**
 * Whether the shop's page is live, as a real switch that saves the moment it
 * is flipped.
 *
 * It used to be a pill that read "Live" next to Copy and Open, so it looked
 * like a status badge, and it only changed the form: nothing happened until
 * "Save page" at the very bottom of a long editor. One owner's page sat hidden
 * that way, and a hidden page stops online booking too, so every link they had
 * handed out said the page didn't exist.
 *
 * Hiding asks first and says what it costs. Turning the page on never asks.
 */
export function hiddenConsequence(booksHere: boolean): string {
  return booksHere
    ? "Online booking stops too. Clients who open your links will see that you aren't taking online bookings right now."
    : "Clients who open your link will see that your page isn't available right now.";
}

const SAVE_FAILED = "Couldn't save. Check your connection and try again.";

export function liveStatus(enabled: boolean, booksHere: boolean): string {
  if (enabled) {
    return booksHere ? "Clients can open your link and book online." : "Clients can open your link.";
  }
  return booksHere
    ? "Hidden, so online booking is off. Your links say you aren't taking online bookings."
    : "Hidden. Your link says your page isn't available right now.";
}

export function PageLiveSwitch({
  initialEnabled,
  booksHere,
}: {
  initialEnabled: boolean;
  /** The shop takes ChairBack bookings, so hiding the page stops them too. */
  booksHere: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // A ref, not just `pending`: a second tap can land before React re-renders
  // the switch as disabled. It clears when the save itself settles, never off
  // `pending` - that stays true for the whole save only under Next's React.
  const busy = useRef(false);

  function commit(next: boolean) {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setConfirming(false);
    startTransition(async () => {
      try {
        const r = await savePageAction({ publicPageEnabled: next });
        if (r.ok) {
          setEnabled(next);
        } else {
          setError(r.error ?? SAVE_FAILED);
        }
      } catch {
        // A server action rejects outright when the connection drops.
        setError(SAVE_FAILED);
      } finally {
        busy.current = false;
      }
    });
  }

  function onToggle() {
    if (pending) return;
    if (enabled) {
      // Hiding costs the shop its online bookings: ask, right here, first.
      setError(null);
      setConfirming(true);
      return;
    }
    commit(true);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p id="page-live-label" className="text-sm font-semibold text-offwhite">
            {enabled ? "Your page is live" : "Your page is hidden"}
          </p>
          <p id="page-live-status" className="mt-0.5 text-xs text-muted" role="status">
            {pending ? "Saving…" : liveStatus(enabled, booksHere)}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="page-live-label"
          aria-describedby="page-live-status"
          disabled={pending}
          onClick={onToggle}
          className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center disabled:opacity-60"
        >
          <span
            aria-hidden
            className={cn(
              "relative inline-flex h-7 w-12 items-center rounded-full transition-colors duration-150 ease-out",
              enabled ? "bg-emerald-soft" : "bg-charcoal-600",
            )}
          >
            <span
              className={cn(
                "inline-block h-5 w-5 rounded-full bg-offwhite shadow transition-transform duration-150 ease-out",
                enabled ? "translate-x-6" : "translate-x-1",
              )}
            />
          </span>
        </button>
      </div>

      {confirming && (
        <div role="alertdialog" aria-labelledby="hide-page-title" className="rounded-xl border border-subtle px-4 py-3">
          <p id="hide-page-title" className="text-sm font-semibold text-offwhite">
            Hide your page?
          </p>
          <p className="mt-1 text-xs text-muted">{hiddenConsequence(booksHere)}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => commit(false)}
              className="min-h-[44px] rounded-full border border-danger-soft/50 px-5 text-sm font-semibold text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/10"
            >
              Hide page
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="min-h-[44px] rounded-full border border-subtle px-5 text-sm text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
            >
              Keep it live
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="text-xs text-danger-soft" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
