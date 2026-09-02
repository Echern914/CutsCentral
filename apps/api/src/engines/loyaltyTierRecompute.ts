import {
  loyaltyTierForVisits,
  LOYALTY_TIER_KEYS,
  type LoyaltyTierKey,
  type TierThresholds,
} from "@chairback/config";
import { Prisma, runWithShop } from "@chairback/db";

/**
 * Re-stamp every client's loyalty tier at one shop.
 *
 * 🔴 WHY THIS HAS TO EXIST. `Client.loyaltyTier` is a STORED column, written
 * by engines/cadence.ts on each completed visit so the clients list can filter
 * and sort thousands of rows without counting visits per row. That cache is
 * correct only for the thresholds it was written under - so the moment a shop
 * changes what Gold takes, every stored tier is a claim about the old rules.
 * Nobody would see an error; they would see a client wearing a badge they no
 * longer hold, which is worse.
 *
 * So the write and this recompute ship together, in one transaction: the
 * thresholds and the tiers they imply are never briefly out of step.
 *
 * The visit definition is COMPLETED visits, lifetime - deliberately the same
 * predicate cadence.ts uses, because two definitions of "a visit" would drift
 * the instant either changed.
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
 * @param tx  Optional caller transaction. Pass the one that WRITES the
 *            thresholds so the two commit together; omit it and this opens
 *            its own.
 */
export async function recomputeLoyaltyTiers(
  shopId: string,
  thresholds: TierThresholds,
  tx?: Prisma.TransactionClient,
): Promise<RecomputeResult> {
  const run = async (db: Prisma.TransactionClient): Promise<RecomputeResult> => {
    // Lifetime COMPLETED visits per client - the same count cadence.ts takes.
    const counts = await db.visit.groupBy({
      by: ["clientId"],
      where: { status: "COMPLETED" },
      _count: { _all: true },
    });
    const byClient = new Map<string, number>();
    for (const row of counts) {
      if (row.clientId) byClient.set(row.clientId, row._count._all);
    }

    // Every client, including those with no visits at all: a shop that RAISES
    // Bronze has clients who must LOSE their badge, and they are exactly the
    // ones a visit-count query would not return.
    const clients = await db.client.findMany({
      select: { id: true, loyaltyTier: true },
    });

    // Bucket by the tier each client should now hold, so the write is a
    // handful of updateMany calls rather than one per client.
    const wanted = new Map<LoyaltyTierKey | "NONE", string[]>();
    let changed = 0;
    for (const c of clients) {
      const tier = loyaltyTierForVisits(byClient.get(c.id) ?? 0, thresholds);
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
          where: { id: { in: ids.slice(i, i + CHUNK) } },
          data: { loyaltyTier: tier },
        });
      }
    }
    return { clients: clients.length, changed };
  };

  return tx ? run(tx) : runWithShop(shopId, (db) => run(db));
}

/** Named so a caller cannot pass the tiers in the wrong order by accident. */
export const RECOMPUTE_TIER_ORDER: readonly LoyaltyTierKey[] = LOYALTY_TIER_KEYS;
