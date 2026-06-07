import { addDays, dayGaps, median } from "@chairback/config";
import { forShop } from "@chairback/db";

/**
 * Recompute a client's visit cadence from their COMPLETED visits.
 * Cadence = MEDIAN of day-gaps between consecutive completed visits (median
 * resists outliers). With <2 completed visits there's no cadence yet.
 *
 * Writes medianIntervalDays, lastVisitAt, nextExpectedAt onto the Client.
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

  if (dates.length < 2) {
    await db.client.update({
      where: { id: clientId },
      data: { medianIntervalDays: null, lastVisitAt, nextExpectedAt: null },
    });
    return;
  }

  const m = median(dayGaps(dates));
  const medianIntervalDays = m === null ? null : Math.round(m);
  const nextExpectedAt =
    lastVisitAt && medianIntervalDays !== null
      ? addDays(lastVisitAt, medianIntervalDays)
      : null;

  await db.client.update({
    where: { id: clientId },
    data: { medianIntervalDays, lastVisitAt, nextExpectedAt },
  });
}
