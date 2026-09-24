import { prisma } from "@chairback/db";
import { blockedRangesByStaff, dropBlockedTargetedSlots } from "./blockedTime.js";
import { occupyingWhere } from "./chairOccupancy.js";

/**
 * Drop targeted slots whose time is not actually free.
 *
 * Every surface that OFFERS TargetedSlot rows goes through here so none can
 * drift: the public flat payload, the /day chips, the open-days sweep - and the
 * barber's own New appointment picker, which is why this lives in an engine
 * rather than inside the public route it was written for. The covering time range is computed from the rows themselves, so callers can't
 * under-fetch.
 *
 * Three things take a special off sale, and it took three separate reports to
 * find all of them:
 *   1. BLOCKED TIME - a one-off exception, a recurring break, or a block
 *      synced from Acuity. The barber saying "I'm not there".
 *   2. A LIVE APPOINTMENT on the same chair, including a walk-in still
 *      mid-cut (see engines/chairOccupancy.ts).
 *   3. A BOOKING SYNCED FROM ACUITY OR SQUARE - a Visit. This one is below.
 */
export async function filterBlockedTargeted<
  T extends { staffId: string; startsAt: Date; durationMin: number },
>(shopId: string, timezone: string, slots: T[]): Promise<T[]> {
  if (slots.length === 0) return slots;
  let fromMs = Number.POSITIVE_INFINITY;
  let toMs = Number.NEGATIVE_INFINITY;
  for (const t of slots) {
    fromMs = Math.min(fromMs, t.startsAt.getTime());
    toMs = Math.max(toMs, t.startsAt.getTime() + t.durationMin * 60_000);
  }
  const staffIds = [...new Set(slots.map((t) => t.staffId))];
  const now = new Date();
  const [blocked, busy, visits] = await Promise.all([
    blockedRangesByStaff({
      shopId,
      staffIds,
      fromMs,
      toMs,
      timezone,
    }),
    // 🔴 A LIVE APPOINTMENT HIDES EVERY SPECIAL IT OVERLAPS. Booking a
    // targeted slot consumes only its OWN row (bookedAppointmentId) - a
    // DIFFERENT special published over the same physical time stayed
    // rendered, and tapping it could only ever end in slot_taken: the write
    // guard has been refusing it all along, so this filter makes the page
    // stop offering what the write was already refusing (the same read/write
    // parity lesson as the Aug 29 grid outage). Same occupancy set the grid
    // subtracts: BOOKED, plus PENDING requests and un-expired receptionist
    // holds.
    prisma.appointment.findMany({
      where: {
        shopId,
        staffId: { in: staffIds },
        // The same occupancy rule the grid and the write guard use - which
        // includes an in-progress walk-in (recorded COMPLETED, still in the
        // chair). See engines/chairOccupancy.ts.
        ...occupyingWhere(now),
        startsAt: { lt: new Date(toMs) },
        endsAt: { gt: new Date(fromMs) },
      },
      select: { staffId: true, startsAt: true, endsAt: true },
    }),
    // 🔴 A BOOKING MADE IN ACUITY HIDES EVERY SPECIAL IT OVERLAPS. Reported by
    // a barber who runs his after-hours as specials: "if someone books an
    // after-hours appointment on Acuity, it still shows I have after-hours
    // available on ChairBack". He was right, and right about why - his regular
    // hours come off the grid (slots.ts subtracts these same Visits) but his
    // specials come from their own table and nothing here ever looked at them.
    // On one live shop that left 20+ specials on sale over confirmed Acuity
    // appointments, the soonest of them the next morning.
    //
    // The write guard has been refusing these all along (bookingWrite.ts runs
    // the same query inside the lock), so the only thing the gap produced was
    // a chip that could not be honoured - the read/write parity lesson, for
    // the third time in this function.
    //
    // SHOP-WIDE, not per staff: a Visit carries no staffId at all, so this is
    // deliberately conservative - exact for a single-chair shop, safe for a
    // multi-chair one. Exactly the stance the grid and the write guard take.
    // A Visit promoted from a NATIVE booking is excluded: its Appointment row
    // is already counted above, and it is the authoritative time.
    prisma.visit.findMany({
      where: {
        shopId,
        status: { in: ["SCHEDULED", "RESCHEDULED"] },
        appointment: null,
        scheduledAt: { lt: new Date(toMs) },
        endAt: { gt: new Date(fromMs) },
      },
      select: { scheduledAt: true, endAt: true },
    }),
  ]);
  for (const a of busy) {
    const ranges = blocked.get(a.staffId) ?? [];
    ranges.push({ start: a.startsAt.getTime(), end: a.endsAt.getTime() });
    blocked.set(a.staffId, ranges);
  }
  // A synced booking blocks EVERY chair's specials, because nothing in the
  // payload says whose chair it was.
  for (const v of visits) {
    if (!v.endAt) continue; // no end = no span to subtract
    const range = { start: v.scheduledAt.getTime(), end: v.endAt.getTime() };
    for (const staffId of staffIds) {
      const ranges = blocked.get(staffId) ?? [];
      ranges.push({ ...range });
      blocked.set(staffId, ranges);
    }
  }
  return dropBlockedTargetedSlots(slots, blocked);
}
