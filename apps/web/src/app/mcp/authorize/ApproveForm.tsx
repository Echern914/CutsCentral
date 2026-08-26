"use client";

import { useState } from "react";
import { approveMcpAuthorization } from "./actions";

/**
 * Approve / cancel.
 *
 * 🔴 THE REDIRECT IS PERFORMED BY THE BROWSER, USING THE URL THE API RETURNED —
 * never one built here. The API has already matched that URI byte-for-byte
 * against the client's registered list; constructing it client-side would move
 * that check to the one place an attacker controls.
 *
 * Cancel navigates nowhere near the client. A user who declines has told us they
 * do not want this software talking to their shop, so we do not then hand it a
 * redirect (an `error=access_denied` callback would be spec-polite and would
 * also confirm to the client that this barber exists and was reachable).
 */
export function ApproveForm({
  clientId,
  redirectUri,
  codeChallenge,
  resource,
  scope,
  state,
}: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
  scope: string | null;
  state: string | null;
}) {
  // Plain state rather than useTransition: this button navigates AWAY from the
  // app on success, so there is no React tree left to keep interactive, and the
  // repo's `startTransition(async ...)` pattern trips the dual-@types/react
  // mismatch that already accounts for a dozen baseline typecheck errors. No
  // reviewer of a security PR should have to work out whether a new one is ours.
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setError(null);
    setPending(true);
    const r = await approveMcpAuthorization({
      clientId,
      redirectUri,
      codeChallenge,
      resource,
      scope,
      state,
    });
    if (r.ok) {
      // Full navigation, not router.push: the destination is the client's own
      // origin (or a loopback listener), which is outside this app entirely.
      window.location.href = r.redirectTo;
      return;
    }
    setError(r.message);
    setPending(false);
  }

  return (
    <div className="mt-6">
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-2xl border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-offwhite"
        >
          {error}
        </p>
      )}
      <div className="flex flex-col gap-2.5 sm:flex-row-reverse">
        <button
          type="button"
          onClick={() => void approve()}
          disabled={pending}
          className="flex-1 rounded-full bg-gold px-6 py-3.5 text-sm font-semibold text-charcoal transition-colors duration-200 ease-out hover:bg-gold-muted disabled:opacity-60"
        >
          {pending ? "Connecting…" : "Connect assistant"}
        </button>
        <a
          href="/dashboard/assistant"
          className="flex-1 rounded-full border border-subtle px-6 py-3.5 text-center text-sm font-semibold text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite"
        >
          Cancel
        </a>
      </div>
    </div>
  );
}
