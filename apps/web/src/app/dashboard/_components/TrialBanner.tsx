import Link from "next/link";
import { PLANS } from "@chairback/config/constants";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { ShowInNativeApp } from "@/components/ShowInNativeApp";
import { IfNativeBillingLink, UpgradeOnWebLink } from "@/components/UpgradeOnWebLink";
import { getBillingSummary } from "@/lib/billing";
import { START_PLAN_HREF, START_PLAN_LABEL, lapseCopy } from "@/lib/lapseCopy";

/**
 * Slim banner under the dashboard nav. Silent while billing is disabled, the
 * shop is subscribed, or it's comped; counts down the trial; once access has
 * lapsed it says WHY (trial over, comp switched off, plan ended - the API's
 * `lapse`, worded in lib/lapseCopy.ts) and sends the owner straight to the
 * plan cards on the billing page with "Start your plan". There is no free
 * tier to fall back to: when access ends the shop stops working.
 *
 * THE 3.1.1 SPLIT LIVES HERE, not in the layout. The layout used to wrap this
 * whole component in HideInNativeApp, which was compliant but left a lapsed
 * shop inside the iOS app with ZERO indication that its booking page and
 * client texts were off — the product just looked broken. Now:
 *   - web: the full banners (price + Upgrade / Set up billing links);
 *   - native app: never a price. A LAPSED shop gets one factual line, and in
 *     an app build that can open Safari the countdown shows without its price
 *     too, each with "Manage plan on getchairback.com ↗" (UpgradeOnWebLink):
 *     billing opens in the browser, which 3.1.1 allows on the US storefront
 *     since 2025. An older build, or NATIVE_EXTERNAL_BILLING_LINK off, gets
 *     the factual lapse line alone and no countdown, as before.
 */
export async function TrialBanner({
  settingUp = false,
}: {
  /**
   * A new shop still setting up (config/onboarding.ts setupComplete): the trial
   * countdown waits until clients can book - unless the trial is nearly over,
   * which they must hear about whatever else they're doing. A lapsed shop's
   * banner always shows: their booking page is off.
   */
  settingUp?: boolean;
} = {}) {
  const res = await getBillingSummary();
  const b = res.data;
  if (!b?.billingEnabled || b.subscribed || b.compAccess) return null;
  // The cheapest plan that is actually for sale: Starter once its price is
  // configured, Premium until then. `starter` is absent on an older payload.
  const from = b.starter?.billingEnabled ? b.starter.priceMonthlyUsd : b.priceMonthlyUsd;

  if (!b.hasAccess) {
    const { headline } = lapseCopy(b.lapse);
    // Only the plans that can actually be bought right now: a tier whose
    // Stripe price is not configured is "almost here" on the billing page.
    const forSale = [
      b.starter?.billingEnabled ? PLANS.starter.name : null,
      PLANS.pro.name,
      b.premiumAi?.billingEnabled ? PLANS.pro_ai.name : null,
    ].filter((n): n is NonNullable<typeof n> => n !== null);
    const choices =
      forSale.length > 1
        ? ` — ${forSale.slice(0, -1).join(", ")} or ${forSale[forSale.length - 1]}`
        : "";
    return (
      <div className="mx-auto mt-3 w-full max-w-6xl px-4">
        <HideInNativeApp>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gold/30 bg-gold/10 px-4 py-2.5 text-xs text-gold sm:text-sm">
            <span>
              {headline} — bookings and your calendar are switched off.
              Everything you set up is still here. Start your plan
              {` (from $${from}/mo${choices}) `}
              to turn your shop back on.
            </span>
            <Link
              href={START_PLAN_HREF}
              className="shrink-0 rounded-full bg-gold px-3.5 py-1.5 font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted"
            >
              {START_PLAN_LABEL}
            </Link>
          </div>
        </HideInNativeApp>
        {/* In the app: what ended and what still works, and - in a build that
            can open Safari - the way to billing THERE (UpgradeOnWebLink). No
            price, ever. An older build, or the kill switch off, gets the
            factual line alone, as before. */}
        <ShowInNativeApp>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gold/30 bg-gold/10 px-4 py-2.5 text-xs text-gold sm:text-sm">
            <span>
              {headline} — bookings and your calendar are switched off. Your
              clients and history are all still here.
            </span>
            <UpgradeOnWebLink>{START_PLAN_LABEL}</UpgradeOnWebLink>
          </div>
        </ShowInNativeApp>
      </div>
    );
  }

  // Still setting up, with more than three days left: nothing competes with
  // the setup checklist (Eric, 2026-10-16).
  if (settingUp && (b.trialDaysLeft === null || b.trialDaysLeft > 3)) return null;

  const daysLeft = `Free trial: ${b.trialDaysLeft} day${b.trialDaysLeft === 1 ? "" : "s"} left.`;
  return (
    <>
      <HideInNativeApp>
        <div className="mx-auto mt-3 w-full max-w-6xl px-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gold/30 bg-gold/10 px-4 py-2.5 text-xs text-gold sm:text-sm">
            <span>
              {daysLeft} Keep everything from ${from}/mo.
            </span>
            <Link
              href="/dashboard/billing"
              className="shrink-0 rounded-full border border-gold/50 px-3.5 py-1.5 font-medium transition-colors duration-150 ease-out hover:bg-gold/10"
            >
              Choose a plan
            </Link>
          </div>
        </div>
      </HideInNativeApp>
      {/* In an app build that can open Safari: the countdown WITHOUT its
          price, beside the way to billing in the browser. Anywhere else in
          the app (older build, kill switch off) nothing, as before. */}
      <IfNativeBillingLink>
        <div className="mx-auto mt-3 w-full max-w-6xl px-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gold/30 bg-gold/10 px-4 py-2.5 text-xs text-gold sm:text-sm">
            <span>{daysLeft}</span>
            <UpgradeOnWebLink>Choose a plan</UpgradeOnWebLink>
          </div>
        </div>
      </IfNativeBillingLink>
    </>
  );
}
