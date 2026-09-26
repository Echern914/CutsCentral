import {
  addDays,
  dayGaps,
  effectiveTier,
  median,
  parseTierRules,
  tierForStats,
  tierStatWindows,
  type LoyaltyTierKey,
} from "@chairback/config";
import { forShop, prisma, runWithShop } from "@chairback/db";
import { lockClientTierFloor } from "../services/clientTier.js";
import { loadClientTierStats } from "./tierStats.js";

/**
 * Recompute a client's visit cadence from their COMPLETED visits.
 * Cadence = MEDIAN of day-gaps between consecutive completed visits (median
 * resists outliers). With <2 completed visits there's no cadence yet.
 *
 * Also stamps the loyalty status tier - this is the one function that runs on
 * every completed-visit change, so the tier stays fresh for free (the dashboard
 * reads the stored column for bulk display/filtering without N counts). The
 * tier stamped is the one HELD - earned, or a higher one set by hand.
 *
 * Writes medianIntervalDays, lastVisitAt, nextExpectedAt, loyaltyTier onto the Client.
 */
export async function recomputeCadence(
  shopId: string,
  clientId: string,
  now: Date = new Date(),
): Promise<void> {
  const db = forShop(shopId);
  const completed = await db.visit.findMany({
    where: { clientId, status: "COMPLETED" },
    orderBy: { scheduledAt: "asc" },
    select: { scheduledAt: true },
  });

  const dates = completed.map((v) => v.scheduledAt);
  const lastVisitAt = dates.length ? dates[dates.length - 1]! : null;

  // 🔴 Read as the OWNER, not through forShop: Shop is default-deny inside a
  // tenant session, so a scoped read returns null and every client would
  // silently fall back to the platform defaults.
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { tierThresholds: true, tierRules: true },
  });
  const rules = parseTierRules(shop?.tierRules, shop?.tierThresholds);
  // A shop on plain lifetime visit counts - every shop until it opts in - is
  // decided by the count already in hand, exactly as before. Only a rule with a
  // window or money in it pays for the extra reads.
  const windows = tierStatWindows(rules);
  const lifetimeVisitsOnly =
    windows.spend.length === 0 && windows.visits.length === 1 && windows.visits[0] === 0;
  const stats = lifetimeVisitsOnly
    ? { visits: { 0: dates.length }, spendCents: {} }
    : await runWithShop(shopId, (tx) => loadClientTierStats(tx, shopId, clientId, rules, now));
  const earned = tierForStats(stats, rules);

  if (dates.length < 2) {
    await stamp(shopId, clientId, earned, { medianIntervalDays: null, lastVisitAt, nextExpectedAt: null });
    return;
  }

  const m = median(dayGaps(dates));
  const rounded = m === null ? null : Math.round(m);
  // A median that rounds to 0 (visits logged the same day / in bursts) is not
  // a real return rhythm — store null ("no cadence yet") rather than 0, which
  // would make the client look overdue one day after walking out the door and
  // trigger nudge/win-back texts for someone who was just in.
  const medianIntervalDays = rounded !== null && rounded >= 1 ? rounded : null;
  const nextExpectedAt =
    lastVisitAt && medianIntervalDays !== null
      ? addDays(lastVisitAt, medianIntervalDays)
      : null;

  await stamp(shopId, clientId, earned, { medianIntervalDays, lastVisitAt, nextExpectedAt });
}

/**
 * Write the cadence and the tier the client HOLDS.
 *
 * 🔴 THE TIER IS effectiveTier(earned, floor), NEVER THE EARNED ONE ALONE. A
 * tier the shop raised them to by hand (Client.loyaltyTierFloor) sticks: a
 * visit can lift them past it, never drop them below it. The floor is read
 * under the row lock the setter also takes (services/clientTier.ts), so a
 * floor committed while this visit was being counted is the one applied.
 */
async function stamp(
  shopId: string,
  clientId: string,
  earned: LoyaltyTierKey | null,
  cadence: { medianIntervalDays: number | null; lastVisitAt: Date | null; nextExpectedAt: Date | null },
): Promise<void> {
  await runWithShop(shopId, async (tx) => {
    const locked = await lockClientTierFloor(tx, shopId, clientId);
    await tx.client.update({
      where: { id: clientId, shopId },
      data: { ...cadence, loyaltyTier: effectiveTier(earned, locked?.floor) },
    });
  });
}
