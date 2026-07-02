import { addDays, dayGaps, median, loyaltyTierForVisits } from "@chairback/config";
import { forShop } from "@chairback/db";

/**
 * Recompute a client's visit cadence from their COMPLETED visits.
 * Cadence = MEDIAN of day-gaps between consecutive completed visits (median
 * resists outliers). With <2 completed visits there's no cadence yet.
 *
 * Also stamps the loyalty status tier (BRONZE/SILVER/GOLD by lifetime completed
 * visits) — this is the one function that runs on every completed-visit change
 * and already has the full count, so the tier stays fresh for free (the
 * dashboard reads the stored column for bulk display/filtering without N counts).
 *
 * Writes medianIntervalDays, lastVisitAt, nextExpectedAt, loyaltyTier onto the Client.
 */
export async function recomputeCadence(
  shopId: string,
  clientId: string,
): Promise<void> {
  const db = forShop(shopId);
  const completed = await db.visit.findMany({
    where: { clientId, status: "COMPLETED" },
    orderBy: { scheduledAt: "asc" },
    select: { scheduledAt: true },
  });

  const dates = completed.map((v) => v.scheduledAt);
  const lastVisitAt = dates.length ? dates[dates.length - 1]! : null;
  // Lifetime completed-visit count drives the loyalty tier (null below the
  // first threshold, e.g. a brand-new client with 0 completed visits).
  const loyaltyTier = loyaltyTierForVisits(dates.length);

  if (dates.length < 2) {
    await db.client.update({
      where: { id: clientId },
      data: { medianIntervalDays: null, lastVisitAt, nextExpectedAt: null, loyaltyTier },
    });
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

  await db.client.update({
    where: { id: clientId },
    data: { medianIntervalDays, lastVisitAt, nextExpectedAt, loyaltyTier },
  });
}
