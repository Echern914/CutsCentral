import { NUDGE, WINBACK } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";

/** Attribution window (days) for a nudge, by kind. Win-back gets a longer window
 * because a DEEPLY lapsed client takes longer to re-engage than a just-overdue
 * one — see WINBACK.attributionWindowDays. Any other kind uses the nudge window. */
function attributionWindowDays(kind: string): number {
  return kind === "winback"
    ? WINBACK.attributionWindowDays
    : NUDGE.attributionWindowDays;
}

/**
 * Link a new booking back to a recent nudge. For each SENT nudge with no
 * attribution yet, find the first visit the client booked AFTER the nudge was
 * sent and within the nudge's kind-specific window; record it. The window is 7
 * days for a rebooking nudge/promo and 14 for a win-back (the deeply-lapsed
 * re-engage slower).
 *
 * Idempotent: only processes nudges with resultedInBookingAt = null.
 */
export async function linkBookingsToNudges(now = new Date()): Promise<number> {
  // Fetch against the WIDEST window across kinds (+1h slack): the job runs
  // hourly, and a nudge whose window closed between runs would otherwise age out
  // of this fetch before its last-hour bookings were ever checked (permanently
  // missed attribution). Each row is then bounded by its own kind's window below.
  const maxWindowDays = Math.max(
    NUDGE.attributionWindowDays,
    WINBACK.attributionWindowDays,
  );
  const windowStart = new Date(
    now.getTime() - (maxWindowDays * 24 + 1) * 60 * 60 * 1000,
  );

  const nudges = await prisma.nudge.findMany({
    where: {
      status: "SENT",
      resultedInBookingAt: null,
      sentAt: { gte: windowStart },
    },
    select: { id: true, clientId: true, shopId: true, sentAt: true, kind: true },
  });

  let linked = 0;
  for (const nudge of nudges) {
    if (!nudge.sentAt) continue;
    const windowEnd = new Date(
      nudge.sentAt.getTime() +
        attributionWindowDays(nudge.kind) * 24 * 60 * 60 * 1000,
    );
    const booking = await prisma.visit.findFirst({
      where: {
        shopId: nudge.shopId,
        clientId: nudge.clientId,
        status: { in: ["SCHEDULED", "COMPLETED", "RESCHEDULED"] },
        createdAt: { gt: nudge.sentAt, lte: windowEnd },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, scheduledAt: true },
    });
    if (booking) {
      await prisma.nudge.update({
        where: { id: nudge.id },
        data: {
          resultedInBookingAt: booking.scheduledAt,
          resultedVisitId: booking.id,
        },
      });
      linked++;
    }
  }

  if (linked) logger.info({ linked }, "attributed bookings to nudges");
  return linked;
}
