/**
 * What a shop promises at each loyalty tier, in the shop's own words.
 *
 * 🔴 WHY THIS IS FREE TEXT AND NOT A FEATURE SWITCH. "Each tier is different
 * access" could mean priority booking, a discount, a free beard trim, first
 * refusal on cancellations - it differs per shop, and most of it happens at
 * the chair rather than in software. Modelling it as enforced entitlements
 * would be inventing a promise ChairBack cannot keep: nothing here gates
 * anything. It is a PROMISE THE SHOP MAKES, displayed to the client who earned
 * it, and honoured by the barber.
 *
 * Stored as one nullable Json column on Shop rather than a table: three short
 * strings that are always read together, always written together, and never
 * queried across shops.
 */

import { LOYALTY_TIER_KEYS, type LoyaltyTierKey } from "./constants.js";

/** Long enough for a real sentence, short enough to sit under a badge. */
export const TIER_PERK_MAX_LENGTH = 120;

/** Tier -> what the shop gives at it. A missing or blank entry means nothing. */
export type TierPerks = Partial<Record<LoyaltyTierKey, string>>;

/**
 * Read a `Shop.tierPerks` Json value into a shape the UI can trust.
 *
 * 🔴 DEFENSIVE ON PURPOSE. This is a Json column, so its runtime type is
 * whatever was last written to it - including from an older release, a bad
 * migration, or a hand-edited row. The rewards page is the worst possible
 * place to discover that, so anything unrecognised degrades to "no perks"
 * rather than throwing at a customer holding their phone.
 */
export function parseTierPerks(raw: unknown): TierPerks {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const out: TierPerks = {};
  for (const key of LOYALTY_TIER_KEYS) {
    const value = source[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim().slice(0, TIER_PERK_MAX_LENGTH);
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

/** The perk for one tier, or null. `null` tier (below the first) has none. */
export function tierPerk(perks: TierPerks, tier: LoyaltyTierKey | null): string | null {
  if (!tier) return null;
  return perks[tier] ?? null;
}

/** True when the shop has written at least one perk worth showing anybody. */
export function hasAnyTierPerk(perks: TierPerks): boolean {
  return LOYALTY_TIER_KEYS.some((k) => Boolean(perks[k]));
}
