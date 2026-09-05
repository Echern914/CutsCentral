import { Prisma } from "@chairback/db";

/**
 * Deciding what a database constraint violation actually MEANS to a customer.
 *
 * 🔴 THE BUG THIS MODULE EXISTS FOR. The public booking route used to catch
 * Prisma's P2002 - "a unique constraint was violated" - and answer, for every
 * one of them, `slot_taken`: *"That time was just taken. Pick another slot."*
 *
 * But the booking transaction touches several unique constraints, and only ONE
 * of them is about the calendar:
 *
 *   - Appointment (staffId, startsAt) WHERE status IN ('BOOKED','PENDING')
 *       ← the real one. Someone else took the chair at that instant.
 *   - Client (shopId, acuityClientKey)
 *       ← two people resolving to the same client key. That happens with a
 *         shared household email or phone, and constantly with the
 *         `anon:<first>-<last>` fallback for a shop that collects neither.
 *   - Client.magicToken / Appointment.manageToken - both globally unique.
 *
 * A customer hitting any of the others was told the TIME was gone. So they
 * picked another time. And another. Every one of them "taken", because the time
 * was never the problem - and nothing in the response could tell them, or us,
 * that the diagnosis was wrong.
 *
 * `slot_taken` is a claim about the CALENDAR. Only the appointment's own index
 * may make it.
 */

/**
 * Which unique constraint a P2002 actually hit, lowercased.
 *
 * Prisma puts it in `meta.target`, as an index NAME on some drivers and as the
 * COLUMN LIST on others. Both shapes are flattened here so callers ask one
 * question of either, and an unexpected shape becomes "" rather than throwing
 * inside a catch block.
 */
export function uniqueTargetOf(err: Prisma.PrismaClientKnownRequestError): string {
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) return target.join(",").toLowerCase();
  if (typeof target === "string") return target.toLowerCase();
  return "";
}

/**
 * Is this P2002 the appointment's own "one booking per chair per start"?
 *
 * The index covers (staffId, startsAt), so BOTH reporting shapes name those two
 * columns - the column-list form directly, and the generated index name
 * (`Appointment_staffId_startsAt_key`) by construction.
 *
 * 🔴 FAILS CLOSED IN THE HONEST DIRECTION. An unrecognised or missing target is
 * NOT a slot conflict: it is reported as an internal failure. Guessing "the
 * time was taken" is precisely the failure being fixed, and it is the guess
 * that costs a booking - the customer acts on it, picks another time, and hits
 * the same wall. A generic "something went wrong, try again" is worse copy and
 * far better advice.
 */
export function isAppointmentSlotConflict(err: Prisma.PrismaClientKnownRequestError): boolean {
  const target = uniqueTargetOf(err);
  if (!target) return false;
  return target.includes("startsat") && target.includes("staffid");
}
