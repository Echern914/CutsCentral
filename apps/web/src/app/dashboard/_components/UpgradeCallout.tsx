import Link from "next/link";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { PlanBadge } from "./PlanBadge";

/**
 * The explanation band on a locked feature's own page: diamond + plan name,
 * the honest one-liner about what's paused (children), and — ON THE WEB ONLY —
 * the steering link to billing. Inside the native app the band simply ends
 * after the explanation: App Store 3.1.1 forbids prices, upgrade CTAs, and
 * links landing on the billing page, and that stripping lives HERE so no
 * call site can forget it. No price is quoted on the web either — the billing
 * page owns prices, and one price-free component can't drift out of
 * compliance when it's reused.
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
      <HideInNativeApp>
        <p className="mt-2">
          <Link
            href="/dashboard/billing"
            className="font-semibold text-gold hover:underline"
          >
            Upgrade to unlock &rarr;
          </Link>
        </p>
      </HideInNativeApp>
    </div>
  );
}
