/**
 * HOW CLOSE TO THE CUT A CLIENT MAY STILL MOVE IT THEMSELVES.
 *
 * A client could move a booking online right up to its start: an 8:00 cut
 * moved at 7:05 left the barber with an hour nobody else could book. The shop
 * now sets a cutoff (`Shop.rescheduleCutoffHours`); inside it the CLIENT can
 * no longer move the booking from the manage link or by text, and is told to
 * contact the shop. Cancelling is untouched - a client who can't cancel is a
 * no-show waiting to happen, and the cancellation window and its fee are a
 * separate setting.
 *
 * Only client-driven moves are limited. The barber moves anything, any time,
 * from the dashboard.
 *
 * One rule, here, because four places must agree: the manage page (whether
 * to offer Reschedule), the reschedule route (whether to refuse it), the SMS
 * receptionist (whether to move it) and the settings form (what may be saved).
 *
 * Pure: no I/O, no clock - callers pass `now`. Imported by client components.
 */

/** What a shop gets until it chooses: a day's notice to move a cut. */
export const DEFAULT_RESCHEDULE_CUTOFF_HOURS = 24;
/** A week. Longer than that is "call the shop for every change". */
export const RESCHEDULE_CUTOFF_MAX_HOURS = 168;

/** True when a client may no longer move this booking themselves. 0 = never. */
export function rescheduleCutoffPassed(input: {
  startsAt: Date;
  now: Date;
  cutoffHours: number;
}): boolean {
  if (!(input.cutoffHours > 0)) return false;
  return input.startsAt.getTime() - input.now.getTime() < input.cutoffHours * 3_600_000;
}

/** When online changes close for this booking, or null when they never do. */
export function rescheduleClosesAt(startsAt: Date, cutoffHours: number): Date | null {
  if (!(cutoffHours > 0)) return null;
  return new Date(startsAt.getTime() - cutoffHours * 3_600_000);
}

/** "24 hours", "1 hour", "2 days" - how the cutoff reads in a sentence. */
export function formatCutoffHours(hours: number): string {
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`;
  if (hours === 24) return "24 hours";
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/**
 * The rule in words, for a policy line (the receptionist's prompt):
 * "clients can move it themselves up to 24 hours before; after that only the
 * shop can".
 */
export function describeReschedulePolicy(cutoffHours: number): string {
  return cutoffHours > 0
    ? `clients can move it themselves up to ${formatCutoffHours(cutoffHours)} before; after that only the shop can move it`
    : "clients can move it themselves any time before the appointment";
}

/** What the client reads once it is too late to move it themselves. */
export function rescheduleClosedMessage(cutoffHours: number, shopName: string): string {
  return `${shopName} takes changes online up to ${formatCutoffHours(
    cutoffHours,
  )} before your appointment. To move it now, contact ${shopName} directly.`;
}

/** The settings form and the settings API: a whole number of hours in range. */
export function isValidRescheduleCutoff(hours: unknown): hours is number {
  return (
    typeof hours === "number" &&
    Number.isInteger(hours) &&
    hours >= 0 &&
    hours <= RESCHEDULE_CUTOFF_MAX_HOURS
  );
}
