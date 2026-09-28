"use client";

import { useState } from "react";
import { emailMarketingAction } from "./actions";
import type { RewardsTheme } from "./theme";

type EmailState = "opted_in" | "needs_consent" | "opted_out";

/**
 * The customer's own on/off for the shop's marketing email, on their rewards
 * page. A quiet line, like the texts line once that is settled: this is a
 * setting, not a sales pitch.
 *
 * On records their yes. Off is exactly the unsubscribe link in every
 * marketing email. Appointment emails are not affected either way, and the
 * line says so, because "stop emails" otherwise reads as "stop everything".
 *
 * 🔴 ONCE UNSUBSCRIBED, THIS PAGE CANNOT TURN EMAILS BACK ON - the shop can
 * open it too. The line says how: the Resubscribe button on the page their
 * emailed Unsubscribe link opens, which only their mailbox can reach.
 */
export function EmailChoice({
  magicToken,
  shopName,
  theme,
  initialState,
}: {
  magicToken: string;
  shopName: string;
  theme: RewardsTheme;
  initialState: EmailState;
}) {
  const [state, setState] = useState<EmailState>(initialState);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function set(on: boolean) {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      const res = await emailMarketingAction(magicToken, on);
      if (res.error === "unsubscribed") {
        // Unsubscribed since this page loaded (from an email, say): show how
        // to get them back rather than a failure.
        setState("opted_out");
        return;
      }
      if (!res.ok || !res.state) {
        setError("Something went wrong. Please try again.");
        return;
      }
      setState(res.state);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  }

  const button = "underline underline-offset-2 transition-colors duration-150 ease-out disabled:opacity-50";
  return (
    <div className="px-1 text-center text-xs" style={{ color: theme.muted }}>
      {state === "opted_in" ? (
        <p>
          You&apos;re getting news and offers from {shopName} by email.{" "}
          <button type="button" onClick={() => void set(false)} disabled={pending} className={button}>
            Stop these emails
          </button>
        </p>
      ) : state === "opted_out" ? (
        <p>
          You&apos;ve unsubscribed from {shopName}&apos;s news and offers emails. To get them again, open the
          Unsubscribe link at the bottom of one of their emails and press Resubscribe.
        </p>
      ) : (
        <p>
          Want news and offers from {shopName} by email?{" "}
          <button
            type="button"
            onClick={() => void set(true)}
            disabled={pending}
            className={button}
            style={{ color: theme.accent }}
          >
            Email me news and offers
          </button>
        </p>
      )}
      <p className="mt-0.5 opacity-80">You&apos;ll still get emails about your appointments.</p>
      {error && (
        <p role="alert" className="mt-1" style={{ color: "#ef4444" }}>
          {error}
        </p>
      )}
    </div>
  );
}
