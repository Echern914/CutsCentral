import Link from "next/link";
import { apiGet } from "@/lib/api";

interface BillingStatus {
  billingEnabled: boolean;
  subscribed: boolean;
  compAccess: boolean;
  hasAccess: boolean;
  trialDaysLeft: number | null;
  priceMonthlyUsd: number;
}

/**
 * Slim banner under the dashboard nav. Silent while billing is disabled, the
 * shop is subscribed, or it's comped; counts down the trial; prompts upgrade
 * once the trial lapses to the Free tier.
 */
export async function TrialBanner() {
  const res = await apiGet<BillingStatus>("/api/billing");
  const b = res.data;
  if (!b?.billingEnabled || b.subscribed || b.compAccess) return null;

  if (!b.hasAccess) {
    return (
      <div className="mx-auto mt-3 w-full max-w-6xl px-4">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gold/30 bg-gold/10 px-4 py-2.5 text-xs text-gold sm:text-sm">
          <span>
            You&apos;re on the Free plan. Go Premium (${b.priceMonthlyUsd}/mo) to
            text your at-risk clients and run promo blasts.
          </span>
          <Link
            href="/dashboard/billing"
            className="shrink-0 rounded-full bg-gold px-3.5 py-1.5 font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted"
          >
            Upgrade
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-3 w-full max-w-6xl px-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gold/30 bg-gold/10 px-4 py-2.5 text-xs text-gold sm:text-sm">
        <span>
          Premium trial: {b.trialDaysLeft} day{b.trialDaysLeft === 1 ? "" : "s"} left.
          Keep your nudges running for ${b.priceMonthlyUsd}/mo.
        </span>
        <Link
          href="/dashboard/billing"
          className="shrink-0 rounded-full border border-gold/50 px-3.5 py-1.5 font-medium transition-colors duration-150 ease-out hover:bg-gold/10"
        >
          Set up billing
        </Link>
      </div>
    </div>
  );
}
