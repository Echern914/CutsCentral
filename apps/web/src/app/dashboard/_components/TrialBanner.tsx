import Link from "next/link";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { ShowInNativeApp } from "@/components/ShowInNativeApp";
import { getBillingSummary } from "@/lib/billing";

/**
 * Slim banner under the dashboard nav. Silent while billing is disabled, the
 * shop is subscribed, or it's comped; counts down the trial; prompts upgrade
 * once the trial lapses. There is no free tier to fall back to: one plan, and
 * when it ends the shop stops working.
 *
 * THE 3.1.1 SPLIT LIVES HERE, not in the layout. The layout used to wrap this
 * whole component in HideInNativeApp, which was compliant but left a lapsed
 * shop inside the iOS app with ZERO indication that its booking page and
 * client texts were off — the product just looked broken. Now:
 *   - web: the full banners (price + Upgrade / Set up billing links);
 *   - native app: the trial countdown stays hidden (it quotes a price), but a
 *     LAPSED shop gets one factual line — no price, no CTA, no billing link,
 *     which is exactly what Guideline 3.1.1 permits.
 */
export async function TrialBanner() {
  const res = await getBillingSummary();
  const b = res.data;
  if (!b?.billingEnabled || b.subscribed || b.compAccess) return null;

  if (!b.hasAccess) {
    return (
      <div className="mx-auto mt-3 w-full max-w-6xl px-4">
        <HideInNativeApp>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gold/30 bg-gold/10 px-4 py-2.5 text-xs text-gold sm:text-sm">
            <span>
              Your ChairBack plan has ended — bookings, texts and your calendar
              are switched off. Subscribe (${b.priceMonthlyUsd}/mo) to turn your
              shop back on.
            </span>
            <Link
              href="/dashboard/billing"
              className="shrink-0 rounded-full bg-gold px-3.5 py-1.5 font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted"
            >
              Upgrade
            </Link>
          </div>
        </HideInNativeApp>
        <ShowInNativeApp>
          <div className="rounded-2xl border border-gold/30 bg-gold/10 px-4 py-2.5 text-xs text-gold sm:text-sm">
            Your ChairBack plan has ended — bookings, texts and your calendar are
            switched off. Your clients and history are all still here.
          </div>
        </ShowInNativeApp>
      </div>
    );
  }

  return (
    <HideInNativeApp>
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
    </HideInNativeApp>
  );
}
