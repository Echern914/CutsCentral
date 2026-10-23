import type { Profile, RewardProgram, TierKey } from "./types";

/**
 * The pure half of the profile's status: which tier to wear on the avatar, and
 * the words under it. No arithmetic about tiers lives here - the shop's rules
 * are evaluated on the server (config/tierRules.ts), and this only chooses
 * among the answers it sent.
 */

const RANK: Record<TierKey, number> = { BRONZE: 1, SILVER: 2, GOLD: 3 };

/** An older API sends no key, only the label; the three labels are fixed. */
const KEY_BY_LABEL: Record<string, TierKey> = { Bronze: "BRONZE", Silver: "SILVER", Gold: "GOLD" };

/** The ring colours when an older API sends none. The same as the tier table. */
const FALLBACK_COLOR: Record<TierKey, string> = { BRONZE: "#B8772F", SILVER: "#8B9199", GOLD: "#D4AF37" };

export interface BestTier {
  key: TierKey;
  label: string;
  color: string;
  shopName: string;
}

export function tierKeyOf(program: RewardProgram): TierKey | null {
  if (program.tier.key) return program.tier.key;
  return program.tier.label ? (KEY_BY_LABEL[program.tier.label] ?? null) : null;
}

/**
 * The highest tier this person holds anywhere - what the ring on their avatar
 * shows. A tie keeps the first shop in the list (the order the API chose), so
 * the ring does not flicker between two Gold shops on refresh.
 */
export function bestTier(programs: RewardProgram[]): BestTier | null {
  let best: BestTier | null = null;
  for (const p of programs) {
    const key = tierKeyOf(p);
    if (!key || !p.tier.label) continue;
    if (!best || RANK[key] > RANK[best.key]) {
      best = { key, label: p.tier.label, color: p.tier.color ?? FALLBACK_COLOR[key], shopName: p.shop.name };
    }
  }
  return best;
}

/** "Jordan Reyes", "Jordan", or null when they have not said. */
export function displayName(profile: Pick<Profile, "firstName" | "lastName"> | undefined): string | null {
  const name = [profile?.firstName, profile?.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return name || null;
}

/**
 * The line under the name. Only the best tier: every shop has its own card
 * right below, so a count of the others here was a longer way to say less.
 */
export function heroLine(best: BestTier | null, programs: RewardProgram[]): string {
  if (best) return `${best.label} member at ${best.shopName}`;
  return programs.length > 0
    ? "Your first visit starts your status"
    : "Your status shows here once a shop you visit runs rewards";
}

/** What the card says under the bar: what is left, or that the top is reached. */
export function tierProgressLine(program: RewardProgram): string | null {
  const next = program.tier.next;
  if (!next) return program.tier.label ? `You're at the top tier at ${program.shop.name}` : null;
  if (next.summary) return next.summary;
  // An API that predates custom rules: tiers were visit counts.
  return `${next.visitsAway} ${next.visitsAway === 1 ? "visit" : "visits"} to ${next.label}`;
}

/**
 * Where the client stands on each rung of a shop's ladder ("Your status"):
 * the held tier is "here", those below "reached", the one right above it
 * "next" (the first rung, before any tier), the rest "ahead". The app's own
 * copy of config tierRules.ts `ladderStates` (the app cannot import config);
 * the same cases are pinned in both test files.
 */
export type LadderState = "here" | "reached" | "next" | "ahead";
export function ladderRows(program: RewardProgram): Array<NonNullable<RewardProgram["tier"]["ladder"]>[number] & { state: LadderState }> {
  const ladder = program.tier.ladder ?? [];
  const held = tierKeyOf(program);
  const at = held ? ladder.findIndex((r) => r.tier === held) : -1;
  if (held && at === -1) return ladder.map((r) => ({ ...r, state: "ahead" as const }));
  return ladder.map((r, i) => ({ ...r, state: i < at ? "reached" : i === at ? "here" : i === at + 1 ? "next" : "ahead" }));
}
