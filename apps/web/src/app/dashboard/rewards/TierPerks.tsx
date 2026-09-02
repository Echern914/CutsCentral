"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
// 🔴 SUBPATH IMPORTS, NOT THE BARREL. "@chairback/config" re-exports
// crypto.ts and session.ts, so importing it from a client component drags
// node:crypto into the browser bundle and next build dies with
// UnhandledSchemeError. Typecheck passes either way - only the build catches it.
import {
  LOYALTY_TIERS,
  LOYALTY_TIER_KEYS,
  type LoyaltyTierKey,
} from "@chairback/config/constants";
import {
  TIER_PERK_MAX_LENGTH,
  type TierPerks as TierPerksMap,
} from "@chairback/config/tierPerks";
import {
  DEFAULT_TIER_THRESHOLDS,
  TIER_MAX_VISITS,
  TIER_MIN_VISITS,
  validateTierThresholds,
  type TierThresholds,
} from "@chairback/config/constants";
import { saveTierPerksAction } from "./actions";

/**
 * What each loyalty tier is worth at THIS shop.
 *
 * 🔴 WHY THIS CARD EXISTS AT ALL. The tiers shipped as a rank and nothing
 * else: a client was told they were Silver and never told what Silver got
 * them, because the answer was "a slightly better place in the waitlist
 * queue", which nobody says out loud. Meanwhile the feature registry pointed
 * "Loyalty status tiers" at this very page, which had no tier UI on it — so an
 * owner searching "gold" landed somewhere that never mentioned gold.
 *
 * 🔴 NOTHING HERE IS ENFORCED, AND THAT IS THE DESIGN. A perk is a promise the
 * shop makes and the barber honours at the chair — a free beard trim, first
 * refusal on a cancellation. Wiring it to entitlements would mean ChairBack
 * promising something it cannot deliver, so the copy below says plainly that
 * we show it and the shop keeps it.
 */
export function TierPerks({
  initial,
  initialThresholds = DEFAULT_TIER_THRESHOLDS,
}: {
  initial: TierPerksMap;
  /** What it takes to reach each tier at THIS shop. */
  initialThresholds?: TierThresholds;
}) {
  const router = useRouter();
  const [perks, setPerks] = useState<TierPerksMap>(initial);
  // Held as strings so a half-typed value ("" while retyping 12) does not snap
  // to a number under the barber's fingers.
  const [visits, setVisits] = useState<Record<LoyaltyTierKey, string>>(() => ({
    BRONZE: String(initialThresholds.BRONZE),
    SILVER: String(initialThresholds.SILVER),
    GOLD: String(initialThresholds.GOLD),
  }));
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The SAME validator the API runs, so the button is disabled for exactly
  // the inputs the server would refuse - no second opinion about the rule.
  const checked = validateTierThresholds({
    BRONZE: visits.BRONZE.trim() === "" ? NaN : Number(visits.BRONZE),
    SILVER: visits.SILVER.trim() === "" ? NaN : Number(visits.SILVER),
    GOLD: visits.GOLD.trim() === "" ? NaN : Number(visits.GOLD),
  });
  const thresholdsDirty =
    checked.ok && LOYALTY_TIER_KEYS.some((k) => checked.value[k] !== initialThresholds[k]);
  const perksDirty = LOYALTY_TIER_KEYS.some((k) => (perks[k] ?? "") !== (initial[k] ?? ""));
  const dirty = perksDirty || thresholdsDirty;
  const thresholdError = checked.ok
    ? null
    : checked.error === "not_increasing"
      ? `${LOYALTY_TIERS[checked.tier].label} has to take more visits than the tier below it.`
      : checked.error === "out_of_range"
        ? `${LOYALTY_TIERS[checked.tier].label} has to be between ${TIER_MIN_VISITS} and ${TIER_MAX_VISITS} visits.`
        : `${LOYALTY_TIERS[checked.tier].label} needs a whole number of visits.`;

  // Plain async rather than useTransition: passing an async callback to
  // startTransition is what produces the repo's inherited @types/react error,
  // and a single save button gains nothing from a transition.
  async function save() {
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      const res = await saveTierPerksAction(perks, checked.ok ? checked.value : undefined);
      if (res?.error) {
        setError(res.error);
        return;
      }
      setSaved(true);
      // The customer page reads this server-side, so refresh rather than
      // leaving the dashboard showing something the client cannot see yet.
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mt-8 rounded-2xl border border-subtle bg-charcoal-800/60 p-5">
      <h2 className="font-display text-xl tracking-tight">What each tier gets</h2>
      <p className="mt-1 text-sm text-muted">
        Clients earn Bronze, Silver and Gold by coming back. Set how many visits each one
        takes, and write what it is worth — both show on their rewards page, under their badge.
      </p>
      <p className="mt-2 text-xs text-muted">
        ChairBack shows the promise; you keep it at the chair. Leave one blank and clients
        simply see the badge.
      </p>

      <div className="mt-5 space-y-4">
        {LOYALTY_TIER_KEYS.map((key: LoyaltyTierKey) => {
          const tier = LOYALTY_TIERS[key];
          const value = perks[key] ?? "";
          return (
            <div key={key}>
              <label
                htmlFor={`perk-${key}`}
                className="mb-1.5 flex items-center gap-2 text-sm font-semibold"
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: tier.color }}
                  aria-hidden
                />
                {tier.label}
              </label>
              <div className="mb-1.5 flex items-center gap-2">
                <input
                  id={`visits-${key}`}
                  type="number"
                  inputMode="numeric"
                  min={TIER_MIN_VISITS}
                  max={TIER_MAX_VISITS}
                  value={visits[key]}
                  onChange={(e) =>
                    setVisits((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                  aria-label={`Visits needed for ${tier.label}`}
                  className="w-20 rounded-lg border border-subtle bg-charcoal-900 px-2.5 py-1.5 text-base text-offwhite focus:border-gold/50 focus:outline-none focus:ring-2 focus:ring-gold/25"
                />
                <span className="text-xs text-muted">visits to reach {tier.label}</span>
              </div>
              <input
                id={`perk-${key}`}
                value={value}
                maxLength={TIER_PERK_MAX_LENGTH}
                onChange={(e) =>
                  setPerks((prev) => ({ ...prev, [key]: e.target.value }))
                }
                placeholder={
                  key === "BRONZE"
                    ? "e.g. Free drink on us"
                    : key === "SILVER"
                      ? "e.g. 10% off products"
                      : "e.g. First pick of cancellations"
                }
                // text-base, not text-sm: iOS Safari zooms the page on focus
                // for anything under 16px.
                className="w-full rounded-xl border border-subtle bg-charcoal-900 px-3 py-2.5 text-base text-offwhite placeholder:text-muted focus:border-gold/50 focus:outline-none focus:ring-2 focus:ring-gold/25"
              />
            </div>
          );
        })}
      </div>

      {thresholdError && (
        <p role="alert" className="mt-4 text-xs text-red-400">
          {thresholdError}
        </p>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={pending || !dirty || !checked.ok}
          className="rounded-full bg-gold px-5 py-2 text-sm font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save tiers"}
        </button>
        {saved && !dirty && <span className="text-sm text-muted">Saved ✓</span>}
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
    </section>
  );
}
