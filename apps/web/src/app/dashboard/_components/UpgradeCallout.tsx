import { UpgradeOnWebLink } from "@/components/UpgradeOnWebLink";
import { PlanBadge } from "./PlanBadge";

/**
 * The explanation band on a locked feature's own page: diamond + plan name,
 * the honest one-liner about what's paused (children), and the way to billing
 * through UpgradeOnWebLink - a link on the web; in the app, a button that opens
 * billing in SAFARI (never in the WebView), or nothing in an older build or
 * with the kill switch off. That split lives in the one component so no call
 * site can forget it. No price is quoted anywhere here — the billing page owns
 * prices, and one price-free component can't drift out of compliance when
 * it's reused.
 *
 * Styling matches the house upsell band (TrialBanner / the billing callout):
 * gold border on gold tint.
 */
export function UpgradeCallout({
  tier,
  children,
}: {
  tier: "pro" | "pro_ai";
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-gold/30 bg-gold/10 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <PlanBadge tier={tier} />
        <span className="text-offwhite">{children}</span>
      </div>
      <UpgradeOnWebLink wrapClassName="mt-2">Upgrade to unlock &rarr;</UpgradeOnWebLink>
    </div>
  );
}
