import { effectiveTier, tierForStats, type LoyaltyTierKey, type TierRules } from "@chairback/config";
import { Prisma, runWithShop } from "@chairback/db";
import { loadTierStats, zeroTierStats } from "./tierStats.js";

/**
 * Re-stamp every client's loyalty tier at one shop.
 *
 * 🔴 WHY THIS HAS TO EXIST. `Client.loyaltyTier` is a STORED column, written
 * by engines/cadence.ts on each completed visit so the clients list can filter
 * and sort thousands of rows without counting visits per row. That cache is
 * correct only for the rules it was written under - so the moment a shop
 * changes what Gold takes, every stored tier is a claim about the old rules.
 * Nobody would see an error; they would see a client wearing a badge they no
 * longer hold, which is worse.
 *
 * So the write and this recompute ship together, in one transaction: the rules
 * and the tiers they imply are never briefly out of step. A rule with a window
 * or money in it also moves with nobody touching anything (a visit ages out of
 * "the last 30 days"), which is what the daily job (tierRecomputeJob.ts) is for.
 *
 * The tier is effectiveTier(tierForStats(), floor) from @chairback/config -
 * earned, or a higher one set by hand - and the numbers come from tierStats.ts:
 * the same evaluation the customer's progress bar reads.
 */

/** Clients per UPDATE. Postgres handles far larger IN lists; this keeps one
 *  shop's recompute from building a single enormous statement. */
const CHUNK = 500;

export interface RecomputeResult {
  clients: number;
  /** How many rows actually moved - 0 means the change was cosmetic. */
  changed: number;
}

/**
 * @param tx   Optional caller transaction. Pass the one that WRITES the rules
 *             so the two commit together; omit it and this opens its own.
 * @param now  The instant windows are measured back from.
 */
export async function recomputeLoyaltyTiers(
  shopId: string,
  rules: TierRules,
  tx?: Prisma.TransactionClient,
  now: Date = new Date(),
): Promise<RecomputeResult> {
  const run = async (db: Prisma.TransactionClient): Promise<RecomputeResult> => {
    const stats = await loadTierStats(db, shopId, rules, now);

    // Every client, including those with no visits at all: a shop that RAISES
    // Bronze has clients who must LOSE their badge, and they are exactly the
    // ones a visit-count query would not return.
    const clients = await db.client.findMany({
      where: { shopId },
      select: { id: true, loyaltyTier: true, loyaltyTierFloor: true },
    });

    // Bucket by the tier each client should now hold AND the floor it was
    // decided with, so the write is a handful of updateMany calls rather than
    // one per client.
    //
    // 🔴 THE TIER HELD, NOT THE TIER EARNED. A tier the shop raised a client to
    // by hand (loyaltyTierFloor) sticks: harder rules, or visits ageing out of
    // a window, can take them down TO it and never below it.
    const zero = zeroTierStats(rules);
    const wanted = new Map<string, { tier: LoyaltyTierKey | null; floor: LoyaltyTierKey | null; ids: string[] }>();
    for (const c of clients) {
      const tier = effectiveTier(tierForStats(stats.get(c.id) ?? zero, rules), c.loyaltyTierFloor);
      if (tier === c.loyaltyTier) continue;
      const key = `${tier ?? "NONE"}|${c.loyaltyTierFloor ?? "NONE"}`;
      const bucket = wanted.get(key);
      if (bucket) bucket.ids.push(c.id);
      else wanted.set(key, { tier, floor: c.loyaltyTierFloor, ids: [c.id] });
    }

    let changed = 0;
    for (const { tier, floor, ids } of wanted.values()) {
      for (let i = 0; i < ids.length; i += CHUNK) {
        // The floor is part of the WHERE: a client whose floor was set or
        // cleared since the read above (services/clientTier.ts, which stamps
        // their tier itself) is skipped, never overwritten with a tier worked
        // out from the floor they no longer have.
        const r = await db.client.updateMany({
          where: { shopId, id: { in: ids.slice(i, i + CHUNK) }, loyaltyTierFloor: floor },
          data: { loyaltyTier: tier },
        });
        changed += r.count;
      }
    }
    return { clients: clients.length, changed };
  };

  return tx ? run(tx) : runWithShop(shopId, (db) => run(db));
}
