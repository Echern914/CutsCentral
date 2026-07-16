"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { isInNativeAppNow } from "@/lib/useIsNativeApp";
import { nudgeClientAction } from "../../actions";

/**
 * The right-side rebook panel on the client detail page: how many days since
 * their last cut, with the Nudge button right under it - the "should I text
 * them?" glance and the action in one place. Days are computed server-side by
 * the parent (server component), so there's no clock drift on hydration.
 */
export function RebookPanel({
  clientId,
  daysSince,
  serviceLabel,
  overdue,
  canNudge,
}: {
  clientId: string;
  /** Whole days since the last completed visit; null = no visits yet. */
  daysSince: number | null;
  /** What the last visit was ("Haircut", "Retwist") - falls back to "visit". */
  serviceLabel: string;
  /** Past the client's expected rebook window -> the count renders in amber. */
  overdue: boolean;
  canNudge: boolean;
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [nudged, setNudged] = useState(false);

  return (
    <div className="flex min-w-40 flex-col items-center gap-2 rounded-2xl border border-subtle bg-charcoal-800 px-5 py-4 text-center">
      {daysSince === null ? (
        <p className="text-sm text-muted">No visits yet</p>
      ) : (
        <>
          <p
            className={cn(
              "font-display text-4xl leading-none",
              overdue ? "text-gold" : "text-offwhite",
            )}
          >
            {daysSince}
          </p>
          <p className="text-xs text-muted">
            {daysSince === 1 ? "day" : "days"} since last {serviceLabel}
          </p>
        </>
      )}
      <button
        disabled={!canNudge || pending || nudged}
        onClick={() =>
          startTransition(async () => {
            const r = await nudgeClientAction(clientId);
            if (r.ok) {
              setNudged(true);
              toast("Nudge sent", "success");
            } else if (r.error === "subscription_required")
              // In-app copy stays neutral: no upgrade prompt there (3.1.1).
              toast(
                isInNativeAppNow()
                  ? "Texting isn't included in your shop's current plan"
                  : "Texting is a Premium feature - upgrade from the Billing page",
                "error",
              );
            else toast("Could not send nudge", "error");
          })
        }
        title={canNudge ? "" : "Opted out or no phone"}
        className="w-full rounded-full border border-gold/50 px-4 py-2 text-xs font-medium text-gold transition-colors duration-150 ease-out hover:bg-gold/10 disabled:opacity-50"
      >
        {nudged ? "Nudge sent" : pending ? "…" : "Nudge now"}
      </button>
    </div>
  );
}
