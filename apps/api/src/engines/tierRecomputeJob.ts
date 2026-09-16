import { parseTierRules, tierRulesNeedDailyRecompute } from "@chairback/config";
import { Prisma, prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { recomputeLoyaltyTiers } from "./loyaltyTierRecompute.js";

/**
 * The daily re-check for shops whose tiers move on their own.
 *
 * "Two visits in the last 30 days" is true today and false next Tuesday with
 * nobody doing anything, and money moves on refunds and checkouts rather than
 * only on completed visits. No write happens at those moments, so without this
 * a client would keep a Gold badge a month after they stopped coming. A shop on
 * plain lifetime visit counts is skipped: every visit write already keeps it
 * exact, and there is nothing for time to change.
 *
 * One shop failing is logged and the rest still run - a shop whose data trips
 * the recompute must not freeze everyone else's badges.
 *
 * @param opts.shopId  Test-only scope, so parallel test files never recompute
 *                     each other's shops.
 */
export async function runTierRecompute(
  opts: { now?: Date; shopId?: string } = {},
): Promise<{ shops: number; clients: number; changed: number; failed: number }> {
  const now = opts.now ?? new Date();
  // Shop is read as the owner: a tenant session sees no Shop rows at all.
  const shops = await prisma.shop.findMany({
    where: { ...(opts.shopId ? { id: opts.shopId } : {}), tierRules: { not: Prisma.DbNull } },
    select: { id: true, tierRules: true, tierThresholds: true },
  });

  const totals = { shops: 0, clients: 0, changed: 0, failed: 0 };
  for (const shop of shops) {
    const rules = parseTierRules(shop.tierRules, shop.tierThresholds);
    if (!tierRulesNeedDailyRecompute(rules)) continue;
    try {
      const r = await recomputeLoyaltyTiers(shop.id, rules, undefined, now);
      totals.shops += 1;
      totals.clients += r.clients;
      totals.changed += r.changed;
    } catch (err) {
      totals.failed += 1;
      logger.error({ err, shopId: shop.id }, "tier recompute failed for a shop");
    }
  }
  return totals;
}
