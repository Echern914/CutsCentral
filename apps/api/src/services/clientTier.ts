import {
  LOYALTY_TIERS,
  describeRequirementProgress,
  describeTierGap,
  parseTierRules,
  tierRulesProgress,
  type LoyaltyTierKey,
  type TierRulesProgress,
} from "@chairback/config";
import { runWithShop, type Prisma } from "@chairback/db";
import { loadClientTierStats } from "../engines/tierStats.js";

/**
 * A CLIENT'S TIER ON THE SHOP'S CLIENT PAGE, AND RAISING IT BY HAND.
 *
 * The owner's ask: "on each client page it should say what member or tier
 * they are and the barber should be able to press it and, if they want, move
 * them up a tier on their own."
 *
 * 🔴 UP ONLY, AND IT STICKS. A hand-set tier is a FLOOR (Client.
 * loyaltyTierFloor), never a replacement: the client holds
 * effectiveTier(earned, floor) from config/tierRules.ts - the higher of the
 * two - so the rules can still lift them past it but nothing the rules do can
 * drop them below it. "Back to automatic" clears the floor.
 *
 * The stored Client.loyaltyTier is ALWAYS that effective tier. Every writer of
 * it - this setter, a completed visit (engines/cadence.ts), and the rules
 * recompute and daily job (engines/loyaltyTierRecompute.ts) - reads the floor
 * and stamps the higher tier, so the clients-list filter, broadcast audiences,
 * tier openings and the waitlist all see the shop's choice without knowing a
 * floor exists.
 */

/** The tier section of GET /api/dashboard/clients/:id, and the setter's answer. */
export interface ClientTierView {
  /** The tier they HOLD - earned, or raised by hand, whichever is higher. */
  current: LoyaltyTierKey | null;
  label: string | null;
  color: string | null;
  /** What the shop's rules alone give them. */
  earned: LoyaltyTierKey | null;
  earnedLabel: string | null;
  /** True only when the hand-set floor is what holds them up (floor > earned). */
  setByHand: boolean;
  /** The stored floor, dormant or not. Null = automatic. */
  floor: LoyaltyTierKey | null;
  /** 0..1 toward the next tier; 1 at the top. */
  fraction: number;
  next: {
    label: string;
    /** "1 more visit in the last 30 days to reach Gold" */
    summary: string | null;
    requirements: { met: boolean; text: string }[];
  } | null;
}

const labelOf = (key: LoyaltyTierKey | null) => (key ? LOYALTY_TIERS[key].label : null);

export function clientTierView(progress: TierRulesProgress, floor: LoyaltyTierKey | null): ClientTierView {
  return {
    current: progress.current,
    label: labelOf(progress.current),
    color: progress.current ? LOYALTY_TIERS[progress.current].color : null,
    earned: progress.earned,
    earnedLabel: labelOf(progress.earned),
    setByHand: progress.setByHand,
    floor,
    fraction: progress.fraction,
    next: progress.next
      ? {
          label: LOYALTY_TIERS[progress.next].label,
          summary: describeTierGap(progress),
          requirements: progress.requirements.map((r) => ({
            met: r.met,
            text: describeRequirementProgress(r),
          })),
        }
      : null,
  };
}

/**
 * Lock ONE client row and read its floor, inside the caller's transaction.
 * Null when the client is not at this shop.
 *
 * 🔴 Every per-client writer of loyaltyTier takes this lock BEFORE it reads
 * the floor: the setter, and the stamp on a completed visit. Without it the
 * visit's stamp could read "no floor", the setter could commit Gold, and the
 * stamp would then write the earned Bronze over it - a Gold floor under a
 * Bronze badge. The shop-wide recompute cannot lock every row, so it guards
 * its writes with the floor it read instead (loyaltyTierRecompute.ts).
 */
export async function lockClientTierFloor(
  tx: Prisma.TransactionClient,
  shopId: string,
  clientId: string,
): Promise<{ floor: LoyaltyTierKey | null } | null> {
  const rows = await tx.$queryRaw<{ loyaltyTierFloor: LoyaltyTierKey | null }[]>`
    SELECT "loyaltyTierFloor" FROM "Client"
    WHERE id = ${clientId} AND "shopId" = ${shopId}
    FOR UPDATE`;
  const row = rows[0];
  return row ? { floor: row.loyaltyTierFloor } : null;
}

export type SetClientTierResult =
  | { ok: true; view: ClientTierView }
  | { ok: false; reason: "not_found" }
  /** At or below what they already earned: a floor there would do nothing. */
  | { ok: false; reason: "not_higher"; view: ClientTierView };

/**
 * Raise a client to `tier` by hand, or (null) hand them back to the rules.
 *
 * One transaction: lock the row, count their numbers with the same loader and
 * rules the client page shows, refuse a tier that is not strictly above what
 * they earned, then write the floor AND re-stamp the stored tier together.
 */
export async function setClientTierFloor(
  shop: { id: string; tierRules: Prisma.JsonValue | null; tierThresholds: Prisma.JsonValue | null },
  clientId: string,
  tier: LoyaltyTierKey | null,
  now: Date = new Date(),
): Promise<SetClientTierResult> {
  const rules = parseTierRules(shop.tierRules, shop.tierThresholds);
  return runWithShop(shop.id, async (tx): Promise<SetClientTierResult> => {
    const locked = await lockClientTierFloor(tx, shop.id, clientId);
    if (!locked) return { ok: false, reason: "not_found" };
    const stats = await loadClientTierStats(tx, shop.id, clientId, rules, now);

    const progress = tierRulesProgress(stats, rules, tier);
    // setByHand is exactly "the floor is above what they earned". A tier at or
    // below the earned one would store a floor that holds nobody up - and say
    // "set by you" about a tier they earned themselves.
    if (tier !== null && !progress.setByHand) {
      return {
        ok: false,
        reason: "not_higher",
        view: clientTierView(tierRulesProgress(stats, rules, locked.floor), locked.floor),
      };
    }

    await tx.client.update({
      where: { id: clientId, shopId: shop.id },
      data: { loyaltyTierFloor: tier, loyaltyTierFloorSetAt: now, loyaltyTier: progress.current },
    });
    return { ok: true, view: clientTierView(progress, tier) };
  });
}
