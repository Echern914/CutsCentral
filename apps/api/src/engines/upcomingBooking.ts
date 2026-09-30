import type { Prisma } from "@chairback/db";

/**
 * WHICH OF THESE CLIENTS ALREADY HAVE A BOOKING AHEAD - so a "come back"
 * message (nudge, win-back) is never sent to someone who is coming back.
 *
 * Both halves, the same predicate rebookNudges.ts has always used:
 *  - a ChairBack appointment ahead that is BOOKED or PENDING (a request the
 *    barber hasn't answered is still a client who asked to come in);
 *  - a synced Acuity / Square visit ahead that is SCHEDULED or RESCHEDULED
 *    (a reschedule moves the same row to its new time; a cancellation is
 *    CANCELED and stops counting).
 *
 * 🔴 The nudge and win-back engines used to read only SCHEDULED synced
 * visits, so every client booked on ChairBack's own page - and every Acuity
 * visit that had been moved once - was still "overdue" and got the text.
 *
 * Batched: one query per half for the whole candidate list.
 */
export async function clientsWithUpcomingBooking(
  tx: Pick<Prisma.TransactionClient, "appointment" | "visit">,
  shopId: string,
  clientIds: string[],
  now: Date,
): Promise<Set<string>> {
  if (clientIds.length === 0) return new Set();
  const [appointments, visits] = await Promise.all([
    tx.appointment.findMany({
      where: {
        shopId,
        clientId: { in: clientIds },
        status: { in: ["BOOKED", "PENDING"] },
        startsAt: { gt: now },
      },
      select: { clientId: true },
      distinct: ["clientId"],
    }),
    tx.visit.findMany({
      where: {
        shopId,
        clientId: { in: clientIds },
        status: { in: ["SCHEDULED", "RESCHEDULED"] },
        scheduledAt: { gt: now },
      },
      select: { clientId: true },
      distinct: ["clientId"],
    }),
  ]);
  const out = new Set<string>();
  for (const a of appointments) if (a.clientId) out.add(a.clientId);
  for (const v of visits) out.add(v.clientId);
  return out;
}
