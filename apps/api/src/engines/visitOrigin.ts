/**
 * WHO OWNS A BOOKING - decided from the Visit's id namespace, in ONE place.
 *
 * Every Visit row carries `acuityAppointmentId`, which despite the name is a
 * namespaced SOURCE id:
 *
 *   "1764227908"        Acuity's own appointment id (bare digits)  - Acuity owns it
 *   "square:{id}"       Square Appointments                        - Square owns it
 *   "booking:{apptId}"  the loyalty Visit the completion promoter writes for a
 *                       finished NATIVE booking                    - ChairBack owns it
 *   "manual:{rand}"     a visit the barber logged by hand          - ChairBack owns it
 *   "demo:..."          the seeded demo shop                       - ChairBack owns it
 *
 * 🔴 WHY THIS EXISTS (FadesByMikey, 2026-09-02). The appointment sheet used to
 * decide "Acuity owns this" from `Appointment.visitId !== null`. But the ONLY
 * thing that sets visitId in production is engines/appointmentPromotion.ts,
 * which links every COMPLETED native booking to the Visit that earned its
 * punches. So the moment a deposit-paid ChairBack booking ended, the sheet
 * flipped to "Managed in Acuity" / "No ChairBack payment recorded" - for a
 * $10 deposit that was sitting, collected, in the barber's Stripe balance.
 * The barber read that as the customer's money being lost.
 *
 * The rule is therefore FAIL-SAFE TOWARD CHAIRBACK: a booking is another
 * platform's only when its Visit id is in a namespace we KNOW belongs to a
 * platform. Anything else - including a namespace added later and forgotten
 * here - reads as ours. At worst that shows a barber a ChairBack payment
 * record that really exists; it can never hide one.
 */

/** True when this Visit id belongs to an external booking platform. */
export function visitOwnedByPlatform(acuityAppointmentId: string): boolean {
  return /^\d+$/.test(acuityAppointmentId) || acuityAppointmentId.startsWith("square:");
}

/**
 * True when a NATIVE appointment row is owned by another platform: it is
 * linked to a Visit that platform ingested. A row with no Visit, or whose
 * Visit is its own completion promotion, is ChairBack's - deposit and all.
 */
export function appointmentOwnedByPlatform(appt: {
  visit: { acuityAppointmentId: string } | null;
}): boolean {
  return appt.visit !== null && visitOwnedByPlatform(appt.visit.acuityAppointmentId);
}
