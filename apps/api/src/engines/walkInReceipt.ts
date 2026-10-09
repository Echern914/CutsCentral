import { appointmentOwnedByPlatform } from "./visitOrigin.js";

/**
 * Name of the auto-provisioned service every walk-in is recorded against
 * (POST /appointments/walk-in, routes/booking.dashboard.ts). Hidden and
 * inactive, so nobody can book it online.
 */
export const WALK_IN_SERVICE_NAME = "Walk-in";

/**
 * IS THIS ROW A WALK-IN THE SHOP RECORDED IN CHAIRBACK - the quick-log receipt
 * POST /appointments/walk-in writes, and nothing else?
 *
 * Asked before a walk-in may be REMOVED (POST /appointments/:id/remove-walk-in),
 * and by the appointment detail so the sheet never guesses from a label. Every
 * marker is one the walk-in route itself writes, and none of them can be
 * changed afterwards (a COMPLETED row is not editable):
 *
 *   - its service is the shop's "Walk-in" service;
 *   - its name is the same "Walk-in" placeholder - the route never asks for one;
 *   - `bookedVia` is null: an online booking, a special, a waitlist or tier
 *     claim, the receptionist and the walk-in QUEUE all stamp their own;
 *   - it is not part of a repeat or a group;
 *   - it is not another platform's visit (a booking synced from Acuity or
 *     Square is changed there, never here).
 *
 * Two independent markers (the service AND the placeholder name) on purpose:
 * a shop that renamed or reused a service called "Walk-in" for real bookings
 * still cannot have a client's booking taken for a walk-in, because those carry
 * the client's own name.
 */
export function isRecordedWalkIn(appt: {
  firstName: string;
  bookedVia: string | null;
  seriesId: string | null;
  groupId: string | null;
  service: { name: string } | null;
  visit: { acuityAppointmentId: string } | null;
}): boolean {
  return (
    appt.service?.name === WALK_IN_SERVICE_NAME &&
    appt.firstName === WALK_IN_SERVICE_NAME &&
    appt.bookedVia === null &&
    appt.seriesId === null &&
    appt.groupId === null &&
    !appointmentOwnedByPlatform(appt)
  );
}
