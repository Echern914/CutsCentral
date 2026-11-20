import { prisma } from "@chairback/db";

/**
 * How many bookings each person already holds on one shop-local day - the
 * number the "any available" rule reads to decide whose turn it is
 * (config/fairChair.ts).
 *
 * WHAT COUNTS: a visit that is on the books or already happened that day
 * (BOOKED, COMPLETED), and a request waiting on the shop (PENDING with no hold
 * timer). A booking already done this morning still counts, or the person who
 * was busy early would be handed the whole afternoon as well.
 *
 * WHAT DOES NOT: CANCELED and NO_SHOW (the chair was given back), and a
 * receptionist HOLD (PENDING with a hold timer) - it is a few minutes of
 * "let me check", not a booking, and it either becomes one or lapses.
 *
 * Counted by the day the visit STARTS, by number of visits and not minutes:
 * the rule a shop owner can check against their own calendar by eye.
 *
 * Someone with nothing that day is simply absent from the map (read as 0).
 */
export async function bookingsByChair(
  shopId: string,
  dayStart: Date,
  dayEnd: Date,
): Promise<Map<string, number>> {
  const rows = await prisma.appointment.groupBy({
    by: ["staffId"],
    where: {
      shopId,
      startsAt: { gte: dayStart, lt: dayEnd },
      OR: [
        { status: { in: ["BOOKED", "COMPLETED"] } },
        { status: "PENDING", holdExpiresAt: null },
      ],
    },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.staffId, r._count._all]));
}
