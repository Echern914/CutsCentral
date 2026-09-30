/**
 * WHO CAN SEE A SERVICE. A barber, 2026-09-29: "a service that is NOT visible
 * to clients and only me ... I can create a service and tap the eye icon to
 * turn it off." (Acuity calls these "Private" appointment types.)
 *
 *  - "public": on the booking page, the receptionist, the kiosk - as before.
 *  - "hidden": the barber books it from the dashboard; no client-facing surface
 *    lists it or accepts a booking for it. A client already booked into one
 *    still sees, moves and cancels their own appointment.
 *
 * A string, not a boolean, so "only clients I pick" can be a third value
 * later without a second migration of the same column. Pinned by a CHECK in
 * SQL (migration 20261036000000).
 *
 * Pure: imported by client components.
 */
export const SERVICE_VISIBILITIES = ["public", "hidden"] as const;
export type ServiceVisibility = (typeof SERVICE_VISIBILITIES)[number];

/** Anything the column could hold that is not a known value reads as public. */
export function isHiddenService(s: { visibility?: string | null }): boolean {
  return s.visibility === "hidden";
}
