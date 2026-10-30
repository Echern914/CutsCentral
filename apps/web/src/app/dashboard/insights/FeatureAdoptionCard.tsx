import Link from "next/link";
import type { FeatureAdoptionRow } from "@chairback/config/featureAdoption";
import { Card, CardHeader } from "@/components/ui/Card";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { PlanBadge } from "../_components/PlanBadge";

/**
 * "What other shops use": the share of active ChairBack shops using each
 * feature, beside whether THIS shop uses it.
 *
 * Totals only - the API rounds every figure to 5% and returns nothing at all
 * below its privacy floor, in which case this card is not drawn. Nothing here
 * names, counts or links to another shop.
 *
 * App Store 3.1.1: inside the native app a feature the plan lacks shows the
 * plan badge (a name, no price) and NO "Upgrade" link; the link is web-only.
 */
export function FeatureAdoptionCard({ features }: { features: FeatureAdoptionRow[] }) {
  if (features.length === 0) return null;
  return (
    <Card>
      <CardHeader
        title="What other shops use"
        subtitle="Share of active ChairBack shops using each feature, rounded to the nearest 5%. Totals only - no shop is ever named."
      />
      <ul className="flex flex-col gap-3 px-5 py-4" data-testid="feature-adoption">
        {features.map((f) => (
          <li key={f.id} data-feature={f.id}>
            <div className="mb-1 flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-offwhite" title={f.label}>
                {f.label}
              </span>
              <span className="shrink-0 tabular-nums text-muted">{f.pct}% of shops</span>
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-charcoal-700"
              role="img"
              aria-label={`${f.pct}% of shops use ${f.label}`}
            >
              <div className="h-full rounded-full bg-gold/70" style={{ width: `${f.pct}%` }} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
              <AdoptionAction row={f} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AdoptionAction({ row }: { row: FeatureAdoptionRow }) {
  if (row.youUseIt) {
    return <span className="text-emerald-soft">You use this ✓</span>;
  }
  if (row.inYourPlan) {
    return (
      <Link href={row.href} className="font-semibold text-gold hover:underline">
        Turn it on &rarr;
      </Link>
    );
  }
  return (
    <>
      <PlanBadge tier="pro" />
      <HideInNativeApp>
        <Link href="/dashboard/billing" className="font-semibold text-gold hover:underline">
          Upgrade &rarr;
        </Link>
      </HideInNativeApp>
    </>
  );
}
