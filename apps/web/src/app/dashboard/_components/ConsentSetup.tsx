"use client";

import { useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";

/**
 * Consent cold-start guidance. A barber who connects Acuity sees their imported
 * clients marked "needs consent" - and won't know why or what to do. Texting is
 * gated on recorded consent (TCPA), so without action the rebooking engine sits
 * idle. This explains the two paths and links to the action.
 *
 * Dismissible (localStorage) so it doesn't nag forever; reappears only if
 * dismissed state is cleared. Shows only when there are clients without consent.
 */
const DISMISS_KEY = "cb_consent_setup_dismissed";

export function ConsentSetup({ needConsentCount }: { needConsentCount: number }) {
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  });

  if (needConsentCount <= 0 || dismissed) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
  }

  return (
    <Card className="mb-6 border-gold/30 p-6">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-display text-lg tracking-tight text-offwhite">
          Before you can text:{" "}
          <span className="text-gold">
            {needConsentCount} client{needConsentCount === 1 ? "" : "s"} need
            consent
          </span>
        </h2>
        <button
          onClick={dismiss}
          className="shrink-0 text-xs text-muted hover:text-offwhite"
          aria-label="Dismiss"
        >
          Dismiss
        </button>
      </div>
      <p className="mt-2 text-sm text-muted">
        To follow texting rules (TCPA), ChairBack only messages clients who
        agreed to receive texts. Two ways to get there:
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-subtle bg-charcoal-700 p-4">
          <p className="text-sm font-medium text-offwhite">
            New clients — automatic
          </p>
          <p className="mt-1 text-xs text-muted">
            In Acuity, add an optional <strong className="text-offwhite">checkbox</strong>{" "}
            intake question like &ldquo;I agree to receive text reminders.&rdquo;
            Anyone who checks it when booking is opted in automatically.
          </p>
          <p className="mt-2 text-[11px] text-muted/80">
            Acuity → Intake Form Questions → add a Checkbox question.
          </p>
        </div>

        <div className="rounded-xl border border-subtle bg-charcoal-700 p-4">
          <p className="text-sm font-medium text-offwhite">
            Existing clients — confirm consent
          </p>
          <p className="mt-1 text-xs text-muted">
            Already have permission to text some clients? Select them on the
            Clients page and choose <strong className="text-offwhite">Mark
            consent</strong> to confirm it.
          </p>
          <Link
            href="/dashboard/clients?filter=needsConsent"
            className="mt-3 inline-block text-xs font-medium text-gold hover:underline"
          >
            Review &amp; mark consent →
          </Link>
        </div>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        Only mark consent for clients who actually agreed to receive texts —
        it&apos;s a record you&apos;re responsible for. Clients can always reply
        STOP to opt out.
      </p>
    </Card>
  );
}
