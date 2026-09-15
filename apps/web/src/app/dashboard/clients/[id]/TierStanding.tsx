import { LOYALTY_TIERS, type LoyaltyTierKey } from "@chairback/config/constants";

export interface ClientTier {
  current: LoyaltyTierKey | null;
  label: string | null;
  color: string | null;
  /** 0..1 toward the next tier; 1 at the top. */
  fraction: number;
  next: {
    label: string;
    /** "1 more visit in the last 30 days to reach Gold" */
    summary: string | null;
    requirements: { met: boolean; text: string }[];
  } | null;
}

/**
 * Where a client stands on this shop's tier ladder: the tier they hold under
 * the shop's rules now, and what the next one still needs - so the barber can
 * say "one more cut this month and you're Gold" at the chair.
 *
 * Server-rendered. The tier word is always written out; the colour only
 * decorates it.
 */
export function TierStanding({ tier, storedTier }: { tier: ClientTier | undefined; storedTier: LoyaltyTierKey | null }) {
  // An API from before tier rules sends only the stored badge.
  if (!tier) {
    if (!storedTier) return null;
    const t = LOYALTY_TIERS[storedTier];
    return (
      <span
        className="mt-1.5 inline-block rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
        style={{ color: t.color, backgroundColor: `${t.color}1A` }}
      >
        {t.label} member
      </span>
    );
  }

  const pct = Math.round(Math.max(0, Math.min(1, tier.fraction)) * 100);
  return (
    <div className="mt-1.5 min-w-0">
      {tier.label && tier.color ? (
        <span
          className="inline-block rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          style={{ color: tier.color, backgroundColor: `${tier.color}1A` }}
          title="Loyalty tier, under this shop's tier rules"
        >
          {tier.label} member
        </span>
      ) : (
        <span className="inline-block text-[10px] font-semibold uppercase tracking-wide text-muted">No tier yet</span>
      )}
      {tier.next && (
        <div className="mt-2 max-w-xs">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-charcoal-700"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={`Progress to ${tier.next.label}`}
          >
            {/* The held tier's colour; gold (progress) before the first tier. */}
            <div
              className={`h-full rounded-full ${tier.color ? "" : "bg-gold"}`}
              style={{ width: `${pct}%`, ...(tier.color ? { backgroundColor: tier.color } : {}) }}
            />
          </div>
          {tier.next.summary && <p className="mt-1 text-xs text-muted">{tier.next.summary}</p>}
          {tier.next.requirements.length > 1 && (
            <ul className="mt-1 space-y-0.5">
              {tier.next.requirements.map((r) => (
                <li key={r.text} className={`text-xs ${r.met ? "text-muted" : "text-offwhite"}`}>
                  <span aria-hidden className="mr-1.5 inline-block w-3 text-center">
                    {r.met ? "✓" : "○"}
                  </span>
                  <span className="sr-only">{r.met ? "Done: " : "To go: "}</span>
                  {r.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
