import { NUDGE } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";

/**
 * Link a new booking back to a recent nudge. For each SENT nudge in the last
 * attributionWindowDays (7) with no attribution yet, find the first visit the
 * client booked AFTER the nudge was sent and within the window; record it.
 *
 * Idempotent: only processes nudges with resultedInBookingAt = null.
 */
export async function linkBookingsToNudges(now = new Date()): Promise<number> {
  const windowStart = new Date(
    now.getTime() - NUDGE.attributionWindowDays * 24 * 60 * 60 * 1000,
  );

  const nudges = await prisma.nudge.findMany({
    where: {
      status: "SENT",
      resultedInBookingAt: null,
      sentAt: { gte: windowStart },
    },
    select: { id: true, clientId: true, shopId: true, sentAt: true },
  });

  let linked = 0;
  for (const nudge of nudges) {
    if (!nudge.sentAt) continue;
    const windowEnd = new Date(
      nudge.sentAt.getTime() + NUDGE.attributionWindowDays * 24 * 60 * 60 * 1000,
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
