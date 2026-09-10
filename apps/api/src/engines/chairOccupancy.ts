import { Prisma, type AppointmentStatus } from "@chairback/db";

/**
 * IS THE CHAIR BUSY? One definition, for the read and the write alike.
 *
 * 🔴 THE BUG THIS EXISTS TO CLOSE (FadesByMikey + Drickcuttinup, Sept 2026).
 * The quick "log a walk-in" button writes the appointment as COMPLETED the
 * moment it is tapped - the money is already in the till - with a span
 * covering the next half hour, because the client is in the chair for it. The
 * Acuity mirror understood that: `appointmentOccupiesTime` reads the SPAN, not
 * the status, so the time was correctly withheld from the external calendar.
 *
 * ChairBack's own booking page did not. The slot grid, the specials filter and
 * the write guard all asked for `status IN ('BOOKED','PENDING')`, so a
 * COMPLETED row counted as free - and for the whole time a barber had someone
 * in the chair, his own booking page kept offering that time and would accept
 * a booking into it. Six overlapping appointments across two live shops came
 * from exactly this, including a walk-in laid over a customer's real 9pm cut.
 *
 * So: an appointment occupies its span until that span ENDS, whatever its
 * status says, EXCEPT where the status means the chair was given back.
 *
 * WHAT DOES NOT OCCUPY, and why:
 *  - CANCELED / NO_SHOW: the chair is free, immediately and at any time. That
 *    is the whole meaning of those states.
 *  - Anything already finished (endsAt in the past). A COMPLETED cut from this
 *    morning must not block this afternoon, and the promotion job flips every
 *    fulfilled booking to COMPLETED after its end - so without the time bound
 *    this would blockade the entire past and every rebooking into it.
 *  - An EXPIRED hold (holdExpiresAt in the past): it released its slot the
 *    instant it lapsed; the sweep that flips it to CANCELED is hygiene, not
 *    what frees the time.
 *
 * 🔴 ONE SIDE EFFECT, TAKEN ON PURPOSE. Marking a cut done EARLY used to hand
 * the rest of its span back to the booking page. It no longer does: the chair
 * reads as busy for as long as the appointment says it runs, which is also
 * exactly what the barber's own calendar has been drawing all along. Trading a
 * few reclaimed minutes for never selling an occupied chair is the right way
 * round, and the barber can still shorten or cancel the row itself.
 */

/** Statuses that mean the chair was handed back, whatever the clock says. */
export const FREED_STATUSES = ["CANCELED", "NO_SHOW"] as const;

/**
 * Does an in-progress COMPLETED row (a walk-in mid-cut) count as busy here?
 *
 * 🔴 "ignore" IS FOR THE BARBER'S OWN HAND, AND ONLY THAT. When he starts the
 * next person in the walk-in queue, that action IS the statement that the
 * chair turned over - the previous walk-in's nominal half hour has not
 * elapsed, but the previous client has got up. Refusing him there would make
 * the queue unusable in exactly the shop that needs it most: a busy one.
 *
 * Every customer-facing path keeps "occupy". A customer has no idea who is in
 * the chair, so the app has to know for them.
 */
export type CompletedInProgress = "occupy" | "ignore";

/**
 * The Prisma `where` for "this appointment is occupying its span".
 *
 * Composed as an OR so it can be spread into an existing filter. Callers add
 * their own staff/shop scoping and the overlap bounds; this contributes only
 * the question of whether the row counts at all.
 *
 * `statuses` is the live set the caller cares about (a couple of writers
 * deliberately ignore PENDING). An in-progress COMPLETED row is added on top
 * of whatever they asked for, because it is not a matter of taste: the client
 * is physically in the chair.
 */
export function occupyingWhere(
  now: Date,
  statuses: readonly AppointmentStatus[] = ["BOOKED", "PENDING"],
  completedInProgress: CompletedInProgress = "occupy",
): Prisma.AppointmentWhereInput {
  const live: Prisma.AppointmentWhereInput = {
    status: { in: [...statuses] },
    // An expired hold has already released its slot.
    OR: [{ holdExpiresAt: null }, { holdExpiresAt: { gt: now } }],
  };
  if (completedInProgress === "ignore") return live;
  return {
    OR: [
      live,
      // The walk-in case: recorded as done, still in the chair.
      { status: "COMPLETED", endsAt: { gt: now } },
    ],
  };
}

/**
 * The same rule as raw SQL, for the write guard - which runs inside the
 * advisory lock and is deliberately hand-written SQL.
 *
 * 🔴 IT MUST SAY THE SAME THING AS occupyingWhere ABOVE. A read that hides a
 * slot the write would accept is a confusing page; a read that OFFERS a slot
 * the write refuses is a customer bounced at the final step; and a write that
 * accepts what the read offered over an occupied chair is the outage this
 * module was written for. bookingWriteOccupancy.test.ts drives both against
 * the same rows and asserts they agree.
 */
export function occupyingSql(
  now: Date,
  statuses: readonly string[],
  completedInProgress: CompletedInProgress = "occupy",
): Prisma.Sql {
  const iso = now.toISOString();
  const live = statuses.includes("PENDING")
    ? Prisma.sql`"status" IN ('BOOKED', 'PENDING')`
    : Prisma.sql`"status" = 'BOOKED'`;
  const liveClause = Prisma.sql`(${live} AND ("holdExpiresAt" IS NULL OR "holdExpiresAt" > ${iso}::timestamp))`;
  if (completedInProgress === "ignore") return Prisma.sql`AND ${liveClause}`;
  return Prisma.sql`AND (
      ${liveClause}
      OR ("status" = 'COMPLETED' AND "endsAt" > ${iso}::timestamp)
    )`;
}
