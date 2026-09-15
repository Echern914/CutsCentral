import { tierForStats, type LoyaltyTierKey, type TierRules } from "@chairback/config";
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
 * The tier is tierForStats() from @chairback/config and the numbers come from
 * tierStats.ts - the same two the customer's progress bar reads.
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
      select: { id: true, loyaltyTier: true },
    });

    // Bucket by the tier each client should now hold, so the write is a
    // handful of updateMany calls rather than one per client.
    const zero = zeroTierStats(rules);
    const wanted = new Map<LoyaltyTierKey | "NONE", string[]>();
    let changed = 0;
    for (const c of clients) {
      const tier = tierForStats(stats.get(c.id) ?? zero, rules);
      if (tier === c.loyaltyTier) continue;
      changed += 1;
      const key = tier ?? "NONE";
      const list = wanted.get(key);
      if (list) list.push(c.id);
      else wanted.set(key, [c.id]);
    }

    for (const [key, ids] of wanted) {
      const tier = key === "NONE" ? null : key;
      for (let i = 0; i < ids.length; i += CHUNK) {
        await db.client.updateMany({
          where: { shopId, id: { in: ids.slice(i, i + CHUNK) } },
          data: { loyaltyTier: tier },
        });
      }
    }
    return { clients: clients.length, changed };
  };

  return tx ? run(tx) : runWithShop(shopId, (db) => run(db));
}
