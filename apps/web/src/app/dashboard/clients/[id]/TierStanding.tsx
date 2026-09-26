"use client";

import { useEffect, useId, useState } from "react";
import { LOYALTY_TIERS, LOYALTY_TIER_KEYS, type LoyaltyTierKey } from "@chairback/config/constants";
import { setClientTierAction } from "../../actions";

export interface ClientTier {
  /** The tier they HOLD: earned, or a higher one set by hand. */
  current: LoyaltyTierKey | null;
  label: string | null;
  color: string | null;
  /**
   * What the shop's rules alone give them. Optional (with the three below) so
   * a web deploy ahead of the API still renders.
   */
  earned?: LoyaltyTierKey | null;
  earnedLabel?: string | null;
  /** True only when the hand-set tier is what holds them up (above earned). */
  setByHand?: boolean;
  /** The stored hand-set tier, or null for automatic. */
  floor?: LoyaltyTierKey | null;
  /** 0..1 toward the next tier; 1 at the top. */
  fraction: number;
  next: {
    label: string;
    /** "1 more visit in the last 30 days to reach Gold" */
    summary: string | null;
    requirements: { met: boolean; text: string }[];
  } | null;
}

// Bigger than the old 10px badge on purpose: the owner could not find it.
const PILL =
  "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide sm:text-sm";

function pillStyle(color: string | null) {
  return color ? { color, backgroundColor: `${color}1A`, borderColor: `${color}66` } : undefined;
}

/**
 * Where a client stands on this shop's tier ladder: the tier they hold, and
 * what the next one still needs - so the shop can say "one more visit this
 * month and you're Gold" in person.
 *
 * For an owner or manager the pill is a button: it opens an inline list of
 * the tiers ABOVE the one they hold ("Move up to Gold") and, when the tier was
 * set by hand, "Back to automatic". UP ONLY, AND IT STICKS - the API keeps a
 * hand-set tier as a floor their visits can lift them past but never below.
 *
 * The list sits in the page flow rather than floating over it, and the result
 * is written inline under the pill: a toast can hide under a dialog on a
 * phone, and a floating menu can run off a narrow screen. The list closes
 * only on a second tap of the pill or after a change lands - never on blur,
 * which on iOS fires before the tap on an option does.
 *
 * The tier word is always written out; the colour only decorates it.
 */
export function TierStanding({
  tier,
  storedTier,
  clientId,
  canChange = false,
}: {
  tier: ClientTier | undefined;
  storedTier: LoyaltyTierKey | null;
  /** Needed to change the tier. Without it (or canChange) the pill is read-only. */
  clientId?: string;
  /** Owner or manager. The API re-checks; this only decides whether to offer. */
  canChange?: boolean;
}) {
  const [shown, setShown] = useState<ClientTier | undefined>(tier);
  // A server refresh (this change's revalidate, or any other edit on the page)
  // is the truth: it replaces whatever this component last drew.
  useEffect(() => setShown(tier), [tier]);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const listId = useId();

  // An API from before tier rules sends only the stored badge.
  if (!shown) {
    if (!storedTier) return null;
    const t = LOYALTY_TIERS[storedTier];
    return (
      <span className={`mt-1.5 ${PILL}`} style={pillStyle(t.color)}>
        {t.label} member
      </span>
    );
  }

  const higher = LOYALTY_TIER_KEYS.slice((shown.current ? LOYALTY_TIER_KEYS.indexOf(shown.current) : -1) + 1);
  const setByHand = shown.setByHand === true;
  const interactive = Boolean(clientId && canChange && (higher.length > 0 || setByHand));

  async function choose(next: LoyaltyTierKey | null) {
    if (!clientId || pending) return;
    setOutcome(null);
    setPending(true);
    try {
      const r = await setClientTierAction(clientId, next);
      if (r.ok && r.tier) {
        setShown(r.tier);
        setOpen(false);
        setOutcome({
          ok: true,
          text: next
            ? `Moved up to ${LOYALTY_TIERS[next].label}.`
            : `Back to automatic: ${r.tier.label ? `${r.tier.label}, as earned` : "no tier earned yet"}.`,
        });
        return;
      }
      setOutcome({
        ok: false,
        text:
          r.error === "not_higher"
            ? "They already hold that tier or a higher one."
            : r.error === "forbidden_role"
              ? "Only the owner or a manager can change a client's tier."
              : r.status === 404
                ? "This client could not be found."
                : (r.message ?? "Could not change the tier. Try again."),
      });
    } catch {
      setOutcome({ ok: false, text: "Could not change the tier. Try again." });
    } finally {
      setPending(false);
    }
  }

  const pillText = shown.label ? `${shown.label} member` : "No tier yet";
  const pct = Math.round(Math.max(0, Math.min(1, shown.fraction)) * 100);
  return (
    <div className="mt-1.5 min-w-0">
      {interactive ? (
        <button
          type="button"
          data-qa="tier-pill"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((o) => !o)}
          className={`${PILL} transition-opacity duration-150 ease-out hover:opacity-80 ${shown.color ? "" : "border-subtle text-muted"}`}
          style={pillStyle(shown.color)}
          title="Change this client's tier"
        >
          <span className="min-w-0 truncate">{pillText}</span>
          <span aria-hidden>{open ? "▴" : "▾"}</span>
        </button>
      ) : shown.label && shown.color ? (
        <span className={PILL} style={pillStyle(shown.color)} title="Loyalty tier, under this shop's tier rules">
          {pillText}
        </span>
      ) : (
        <span className={`${PILL} border-subtle text-muted`}>{pillText}</span>
      )}

      {setByHand && (
        <p className="mt-1 text-xs text-muted" data-qa="tier-set-by-hand">
          Set by you - {shown.earnedLabel ? `earned ${shown.earnedLabel}` : "no tier earned yet"}
        </p>
      )}

      {interactive && open && (
        <div
          id={listId}
          role="group"
          aria-label="Change tier"
          className="mt-2 flex w-full max-w-xs flex-col gap-1.5 rounded-xl border border-subtle bg-charcoal-800 p-2"
        >
          {higher.map((k) => (
            <button
              key={k}
              type="button"
              disabled={pending}
              onClick={() => void choose(k)}
              className="flex min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
            >
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: LOYALTY_TIERS[k].color }}
              />
              <span className="min-w-0">Move up to {LOYALTY_TIERS[k].label}</span>
            </button>
          ))}
          {setByHand && (
            <button
              type="button"
              disabled={pending}
              onClick={() => void choose(null)}
              className="min-w-0 rounded-lg px-3 py-2 text-left text-sm text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
            >
              Back to automatic (earned: {shown.earnedLabel ?? "no tier"})
            </button>
          )}
          <p className="px-3 pb-1 text-xs text-muted">
            A tier you set sticks. Their visits can still move them higher, never lower.
          </p>
        </div>
      )}

      {(pending || outcome) && (
        <p
          role="status"
          aria-live="polite"
          className={`mt-1 text-xs ${pending ? "text-muted" : outcome?.ok ? "text-emerald-soft" : "text-danger-soft"}`}
        >
          {pending ? "Saving…" : outcome?.text}
        </p>
      )}

      {shown.next && (
        <div className="mt-2 max-w-xs">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-charcoal-700"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={`Progress to ${shown.next.label}`}
          >
            {/* The held tier's colour; gold (progress) before the first tier. */}
            <div
              className={`h-full rounded-full ${shown.color ? "" : "bg-gold"}`}
              style={{ width: `${pct}%`, ...(shown.color ? { backgroundColor: shown.color } : {}) }}
            />
          </div>
          {shown.next.summary && <p className="mt-1 text-xs text-muted">{shown.next.summary}</p>}
          {shown.next.requirements.length > 1 && (
            <ul className="mt-1 space-y-0.5">
              {shown.next.requirements.map((r) => (
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
