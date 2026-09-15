"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
// 🔴 SUBPATH IMPORTS, NOT THE BARREL. "@chairback/config" re-exports
// crypto.ts and session.ts, so importing it from a client component drags
// node:crypto into the browser bundle and next build dies with
// UnhandledSchemeError. Typecheck passes either way - only the build catches it.
import {
  DEFAULT_TIER_THRESHOLDS,
  LOYALTY_TIERS,
  LOYALTY_TIER_KEYS,
  TIER_MAX_VISITS,
  TIER_MIN_VISITS,
  type LoyaltyTierKey,
  type TierThresholds,
} from "@chairback/config/constants";
import {
  TIER_PERK_MAX_LENGTH,
  type TierPerks as TierPerksMap,
} from "@chairback/config/tierPerks";
import {
  TIER_MAX_SPEND_CENTS,
  TIER_MIN_SPEND_CENTS,
  TIER_WINDOWS,
  describeTierRule,
  formatTierMoney,
  rulesFromThresholds,
  tierWindowPhrase,
  validateTierRules,
  type TierRuleError,
  type TierRules,
  type TierWindowDays,
} from "@chairback/config/tierRules";
import { cap, useVocab } from "@/components/VocabProvider";
import { saveTierPerksAction } from "./actions";

/**
 * What each loyalty tier TAKES at this shop, and what it is WORTH.
 *
 * A tier can ask for visits, money, or both - each over its own stretch of
 * time ("2 visits in the last 30 days and $200 spent") - and say whether it
 * needs both or either one. The page runs validateTierRules, the same function
 * the API does, so Save is off for exactly what the server would refuse.
 *
 * 🔴 WHY THIS CARD EXISTS AT ALL. The tiers shipped as a rank and nothing
 * else: a client was told they were Silver and never told what Silver got
 * them. Meanwhile the feature registry pointed "Loyalty status tiers" at this
 * very page, which had no tier UI on it.
 *
 * 🔴 NOTHING ABOUT A PERK IS ENFORCED, AND THAT IS THE DESIGN. A perk is a
 * promise the shop makes and the barber honours at the chair, so the copy says
 * plainly that we show it and the shop keeps it.
 */

/** One tier as it is being typed. Numbers stay strings so "" while retyping never snaps. */
interface Draft {
  visitsOn: boolean;
  visits: string;
  visitsWindow: TierWindowDays;
  spendOn: boolean;
  /** Whole dollars, as typed. */
  spend: string;
  spendWindow: TierWindowDays;
  match: "all" | "any";
}

function toDraft(rules: TierRules): Record<LoyaltyTierKey, Draft> {
  const out = {} as Record<LoyaltyTierKey, Draft>;
  for (const key of LOYALTY_TIER_KEYS) {
    const r = rules[key];
    out[key] = {
      visitsOn: r.visits !== null,
      visits: r.visits ? String(r.visits.min) : "",
      visitsWindow: r.visits?.windowDays ?? 0,
      spendOn: r.spend !== null,
      spend: r.spend ? String(r.spend.minCents / 100) : "",
      spendWindow: r.spend?.windowDays ?? 0,
      match: r.match,
    };
  }
  return out;
}

const parsed = (s: string) => (s.trim() === "" ? NaN : Number(s));

function fromDraft(drafts: Record<LoyaltyTierKey, Draft>): TierRules {
  const out = {} as TierRules;
  for (const key of LOYALTY_TIER_KEYS) {
    const d = drafts[key];
    out[key] = {
      visits: d.visitsOn ? { min: parsed(d.visits), windowDays: d.visitsWindow } : null,
      spend: d.spendOn ? { minCents: Math.round(parsed(d.spend) * 100), windowDays: d.spendWindow } : null,
      match: d.match,
    };
  }
  return out;
}

function errorCopy(error: TierRuleError, tier: LoyaltyTierKey): string {
  const label = LOYALTY_TIERS[tier].label;
  switch (error) {
    case "no_requirement":
      return `${label} needs something to earn it - visits, money spent, or both.`;
    case "visits_out_of_range":
      return `${label} has to take between ${TIER_MIN_VISITS} and ${TIER_MAX_VISITS} visits.`;
    case "spend_out_of_range":
      return `${label} has to take between ${formatTierMoney(TIER_MIN_SPEND_CENTS)} and ${formatTierMoney(TIER_MAX_SPEND_CENTS)}.`;
    case "easier_than_below":
      return `${label} can't ask for less than the tier below it over the same stretch of time.`;
    case "same_as_below":
      return `${label} can't be exactly the same as the tier below it - nobody could ever hold that one.`;
    case "bad_window":
    case "bad_match":
      return `Check how ${label} is set.`;
  }
}

const inputClass =
  "rounded-lg border border-subtle bg-charcoal-900 px-2.5 py-1.5 text-base text-offwhite focus:border-gold/50 focus:outline-none focus:ring-2 focus:ring-gold/25";

function WindowSelect({
  value,
  onChange,
  label,
  disabled,
}: {
  value: TierWindowDays;
  onChange: (v: TierWindowDays) => void;
  label: string;
  disabled: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value) as TierWindowDays)}
      aria-label={label}
      className={`${inputClass} disabled:opacity-50`}
    >
      {TIER_WINDOWS.map((w) => (
        <option key={w} value={w}>
          {tierWindowPhrase(w)}
        </option>
      ))}
    </select>
  );
}

export function TierPerks({
  initial,
  initialRules,
  initialThresholds = DEFAULT_TIER_THRESHOLDS,
}: {
  initial: TierPerksMap;
  /** The rules in force at this shop (the API always sends them). */
  initialRules?: TierRules;
  /** Only for an API that predates rules. */
  initialThresholds?: TierThresholds;
}) {
  const router = useRouter();
  // The shop's own words: a nail studio keeps its promise at a station, not
  // a chair. (The vocabulary guard only scans string literals, so this JSX
  // text slipped past it - worth knowing when reading a green lint.)
  const vocab = useVocab();
  const startRules = initialRules ?? rulesFromThresholds(initialThresholds);
  const [perks, setPerks] = useState<TierPerksMap>(initial);
  const [drafts, setDrafts] = useState(() => toDraft(startRules));
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rules = fromDraft(drafts);
  const checked = validateTierRules(rules);
  const rulesDirty = JSON.stringify(rules) !== JSON.stringify(fromDraft(toDraft(startRules)));
  const perksDirty = LOYALTY_TIER_KEYS.some((k) => (perks[k] ?? "") !== (initial[k] ?? ""));
  const dirty = perksDirty || rulesDirty;
  const ruleError = checked.ok ? null : errorCopy(checked.error, checked.tier);

  const edit = (key: LoyaltyTierKey, patch: Partial<Draft>) => {
    setSaved(null);
    setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  };

  // Plain async rather than useTransition: passing an async callback to
  // startTransition is what produces the repo's inherited @types/react error,
  // and a single save button gains nothing from a transition.
  async function save() {
    if (!checked.ok) return;
    setError(null);
    setSaved(null);
    setPending(true);
    try {
      const res = await saveTierPerksAction(perks, rulesDirty ? checked.value : undefined);
      if (res?.error) {
        setError(res.error);
        return;
      }
      setSaved(
        rulesDirty && res.moved !== undefined
          ? res.moved === 0
            ? "Saved ✓ - nobody changed tier."
            : `Saved ✓ - ${res.moved} ${res.moved === 1 ? vocab.clientNoun : vocab.clientNounPlural} moved tier.`
          : "Saved ✓",
      );
      // The customer page reads this server-side, so refresh rather than
      // leaving the dashboard showing something the client cannot see yet.
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    // `id` is the registry's deep link (FEATURE_INDEX "loyalty-tiers").
    <section id="tiers" className="mt-8 rounded-2xl border border-subtle bg-charcoal-800/60 p-5">
      <h2 className="font-display text-xl tracking-tight">Tiers</h2>
      <p className="mt-1 text-sm text-muted">
        {cap(vocab.clientNounPlural)} earn Bronze, Silver and Gold. Decide what each one takes -
        visits, money spent, or both, over whatever stretch of time you like - and what it is
        worth. Both show on their rewards page, under their badge.
      </p>
      <p className="mt-2 text-xs text-muted">
        Money counts what they actually paid: refunds come off and a no-show counts nothing.
        ChairBack shows the promise; you keep it at the {vocab.stationNoun}.
      </p>

      <div className="mt-5 space-y-4">
        {LOYALTY_TIER_KEYS.map((key) => {
          const tier = LOYALTY_TIERS[key];
          const d = drafts[key];
          const both = d.visitsOn && d.spendOn;
          // The sentence previews this tier on its own numbers; how it ranks
          // against its neighbours is the alert below the list.
          const r = rules[key];
          const ownOk =
            (r.visits !== null || r.spend !== null) &&
            (!r.visits ||
              (Number.isInteger(r.visits.min) && r.visits.min >= TIER_MIN_VISITS && r.visits.min <= TIER_MAX_VISITS)) &&
            (!r.spend ||
              (Number.isInteger(r.spend.minCents) &&
                r.spend.minCents >= TIER_MIN_SPEND_CENTS &&
                r.spend.minCents <= TIER_MAX_SPEND_CENTS));
          return (
            <fieldset key={key} className="min-w-0 rounded-xl border border-subtle p-4">
              <legend className="flex items-center gap-2 px-1 text-sm font-semibold">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: tier.color }}
                  aria-hidden
                />
                {tier.label}
              </legend>

              <p className="text-xs uppercase tracking-wide text-muted">What it takes</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={d.visitsOn}
                    onChange={(e) => edit(key, { visitsOn: e.target.checked, visits: d.visits || "1" })}
                    className="h-4 w-4 accent-gold"
                  />
                  Visits
                </label>
                <input
                  type="number"
                  inputMode="numeric"
                  min={TIER_MIN_VISITS}
                  max={TIER_MAX_VISITS}
                  value={d.visits}
                  disabled={!d.visitsOn}
                  onChange={(e) => edit(key, { visits: e.target.value })}
                  aria-label={`Visits needed for ${tier.label}`}
                  className={`w-20 ${inputClass} disabled:opacity-50`}
                />
                <WindowSelect
                  value={d.visitsWindow}
                  disabled={!d.visitsOn}
                  onChange={(v) => edit(key, { visitsWindow: v })}
                  label={`How far back ${tier.label} counts visits`}
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={d.spendOn}
                    onChange={(e) => edit(key, { spendOn: e.target.checked, spend: d.spend || "100" })}
                    className="h-4 w-4 accent-gold"
                  />
                  Money spent
                </label>
                <span className="flex items-center gap-1">
                  <span className="text-sm text-muted" aria-hidden>
                    $
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={TIER_MIN_SPEND_CENTS / 100}
                    max={TIER_MAX_SPEND_CENTS / 100}
                    step="1"
                    value={d.spend}
                    disabled={!d.spendOn}
                    onChange={(e) => edit(key, { spend: e.target.value })}
                    aria-label={`Dollars spent for ${tier.label}`}
                    className={`w-24 ${inputClass} disabled:opacity-50`}
                  />
                </span>
                <WindowSelect
                  value={d.spendWindow}
                  disabled={!d.spendOn}
                  onChange={(v) => edit(key, { spendWindow: v })}
                  label={`How far back ${tier.label} counts money spent`}
                />
              </div>

              {both && (
                <div
                  role="radiogroup"
                  aria-label={`What ${tier.label} needs`}
                  className="mt-3 inline-flex rounded-full border border-subtle p-0.5 text-xs"
                >
                  {(["all", "any"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={d.match === m}
                      onClick={() => edit(key, { match: m })}
                      className={`rounded-full px-3 py-1 transition-colors duration-150 ease-out ${
                        d.match === m ? "bg-gold text-charcoal" : "text-muted hover:text-offwhite"
                      }`}
                    >
                      {m === "all" ? "Needs both" : "Either one"}
                    </button>
                  ))}
                </div>
              )}

              <p className="mt-2 text-xs text-muted" aria-live="polite">
                {ownOk ? `${tier.label}: ${describeTierRule(r)}` : null}
              </p>

              <label htmlFor={`perk-${key}`} className="mt-3 block text-xs uppercase tracking-wide text-muted">
                What it gets
              </label>
              <input
                id={`perk-${key}`}
                value={perks[key] ?? ""}
                maxLength={TIER_PERK_MAX_LENGTH}
                onChange={(e) => {
                  setSaved(null);
                  setPerks((prev) => ({ ...prev, [key]: e.target.value }));
                }}
                placeholder={
                  key === "BRONZE"
                    ? "e.g. Free drink on us"
                    : key === "SILVER"
                      ? "e.g. 10% off products"
                      : "e.g. First pick of cancellations"
                }
                // text-base, not text-sm: iOS Safari zooms the page on focus
                // for anything under 16px.
                className="mt-1.5 w-full rounded-xl border border-subtle bg-charcoal-900 px-3 py-2.5 text-base text-offwhite placeholder:text-muted focus:border-gold/50 focus:outline-none focus:ring-2 focus:ring-gold/25"
              />
            </fieldset>
          );
        })}
      </div>

      {ruleError && (
        <p role="alert" className="mt-4 text-xs text-red-400">
          {ruleError}
        </p>
      )}
      {rulesDirty && checked.ok && (
        <p className="mt-4 text-xs text-muted">
          Saving moves every {vocab.clientNoun} to the tier these rules give them, right away.
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={pending || !dirty || !checked.ok}
          className="rounded-full bg-gold px-5 py-2 text-sm font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save tiers"}
        </button>
        {saved && !dirty && <span className="text-sm text-muted">{saved}</span>}
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
    </section>
  );
}
