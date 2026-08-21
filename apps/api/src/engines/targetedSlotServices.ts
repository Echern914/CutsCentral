/**
 * Which services a targeted slot (or series) is offered under.
 *
 * A slot used to carry exactly one serviceId. It can now be listed under
 * several - "this 8:30 PM hour is available as a retwist OR a line-up" - which
 * is a JOIN, not extra slot rows.
 *
 * 🔑 ONE ROW, MANY LISTINGS. There is still exactly one TargetedSlot per
 * physical appointment time, and capacity lives on it
 * (bookedAppointmentId is UNIQUE). So booking it through ANY of its services
 * consumes it for all of them, and there is never a second availability record
 * for the same hour. Publishing one row per service would have been a
 * double-book waiting to happen.
 *
 * Every read path goes through here so none can drift on what "eligible" means:
 * the flat public payload, the /day chips, the open-days sweep, the booking
 * POST's eligibility check, and rule materialisation.
 */

/** Include this on any targeted-slot query whose result reaches slotServiceIds. */
export const SLOT_SERVICES_SELECT = { select: { serviceId: true } } as const;

interface HasServices {
  /** The denormalised first service. Kept for backward compatibility. */
  serviceId: string;
  /** The join rows, when the query loaded them. */
  services?: { serviceId: string }[];
}

/**
 * The service ids this slot may be booked as, newest shape first.
 *
 * FALLS BACK TO serviceId when the join is empty or was not selected. That is
 * not defensive noise: it is what guarantees a row created before the backfill
 * - or by any path not yet writing the join - behaves exactly as it did
 * before, listed under its one original service. The migration backfilled every
 * existing row to a one-element set, so in practice the two agree.
 */
export function slotServiceIds(slot: HasServices): string[] {
  const joined = slot.services?.map((s) => s.serviceId) ?? [];
  if (joined.length === 0) return [slot.serviceId];
  // Dedupe defensively; the unique index already prevents duplicates.
  return [...new Set(joined)];
}

/** True when this slot may be booked as `serviceId`. The booking-POST gate. */
export function slotOffersService(slot: HasServices, serviceId: string): boolean {
  return slotServiceIds(slot).includes(serviceId);
}
