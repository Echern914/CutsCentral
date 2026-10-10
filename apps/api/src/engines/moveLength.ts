/**
 * HOW LONG A MOVED BOOKING RUNS. Pure: the caller measures the service.
 *
 * 🔴 THE BUG THIS CLOSES. Both reschedule routes - the client's own, from the
 * manage link, and the shop's - set the new end from the SERVICE alone. A
 * 30-minute cut booked with a 30-minute add-on, or stretched to 45 by the
 * shop, came out of a move holding 30 minutes; the rest of the hour went back
 * on the booking page and was sold to somebody else, who arrived to find the
 * chair taken.
 *
 * So a move keeps the booking's OWN minutes - everything it runs beyond (or
 * short of) its service: add-ons, a length the shop set by hand - and only the
 * service's part is measured again at the new time. That second half is not a
 * nicety: a service can run 20 minutes on a Friday and 30 the rest of the week
 * (weekday overrides, time-of-day windows), and a Friday cut moved to a Monday
 * must take Monday's length. With no such overrides the two measures agree and
 * the booking keeps its length exactly, which is also what the dashboard's own
 * edit sheet does (booking.appointmentEdit.ts).
 *
 * `extraMin` is what `isSlotBookable` / `blockedTimeIsTheOnlyObstacle` need to
 * check the new time for the WHOLE booking - the same mechanism the create
 * path uses for add-ons (start times come from the service grid; the room
 * required is the full length). Never negative: a booking shorter than its
 * service is checked for the service, which is stricter, never looser.
 *
 * A trim can never wipe the booking out: the result is no shorter than the
 * shorter of its old length and the service's length at the new time.
 */
export function movedLengthMin(input: {
  /** The booking's span now: endsAt - startsAt, in minutes. */
  currentMin: number;
  /** The service's own length at the OLD start. */
  serviceMinAtOld: number;
  /** The service's own length at the NEW start. */
  serviceMinAtNew: number;
}): { lengthMin: number; extraMin: number } {
  const own = input.currentMin - input.serviceMinAtOld;
  const floor = Math.min(input.currentMin, input.serviceMinAtNew);
  const lengthMin = Math.max(floor, input.serviceMinAtNew + own);
  return { lengthMin, extraMin: Math.max(0, lengthMin - input.serviceMinAtNew) };
}
