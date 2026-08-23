"use client";

import { useState, useTransition } from "react";
import { cancelWaitlistAction } from "./actions";

/**
 * Confirm-then-cancel. The API answers identically whether or not the token
 * matched anything (it takes a bearer secret and must not become an oracle),
 * so this screen says the same thing either way: you are off the list. That is
 * true in both cases from the customer's point of view.
 */
export function CancelWaitlist({ token }: { token: string }) {
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  if (done) {
    return (
      <div
        role="status"
        className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center"
      >
        <h1 className="font-display text-2xl">You&rsquo;re off the list</h1>
        <p className="mt-2 text-sm text-muted">
          We won&rsquo;t email you about openings any more. You can join again
          from the shop&rsquo;s booking page whenever you like.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
      <h1 className="font-display text-2xl">Leave the waitlist?</h1>
      <p className="mt-2 text-sm text-muted">
        You&rsquo;ll stop getting emails when a spot opens up.
      </p>
      <button
        type="button"
        disabled={pending}
        aria-busy={pending}
        onClick={() =>
          start(async () => {
            await cancelWaitlistAction(token);
            setDone(true);
          })
        }
        className="mt-5 w-full rounded-xl border border-white/15 bg-white/10 py-3 text-sm font-semibold text-offwhite transition-colors hover:bg-white/15 disabled:opacity-50"
      >
        {pending ? "Removing…" : "Take me off the list"}
      </button>
    </div>
  );
}
