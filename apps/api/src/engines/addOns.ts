import { forShop } from "@chairback/db";
import { addOnOffersService } from "@chairback/config/addOns";

/**
 * Resolve a set of chosen add-on ids into their snapshot + the extra duration
 * and price they contribute to an appointment. Only ACTIVE add-ons that belong
 * to the shop AND are offered with the service (`addOnOffersService`: an empty
 * service list means every service - the same rule both booking forms list
 * by) are honored. Anything else is left out of the result, so a stale or
 * crafted id can't inflate the price or grab a foreign add-on. Whether a
 * left-out id is then dropped (the customer's page) or refused (the barber's
 * form - see keepsEveryAddOn) is the caller's call.
 *
 * The returned `snapshot` is frozen onto Appointment.addOns so a later edit or
 * delete of the add-on never rewrites a past booking; `extraDurationMin` folds
 * into endsAt and `extraPrice` into priceAtBooking at create time.
 */
export interface AddOnSnapshotItem {
  id: string;
  name: string;
  durationMin: number;
  price: number | null;
}

export interface ResolvedAddOns {
  snapshot: AddOnSnapshotItem[];
  extraDurationMin: number;
  extraPrice: number;
}

/** No add-ons: a special, a repeating series, or nothing chosen. */
export const NO_ADD_ONS: ResolvedAddOns = { snapshot: [], extraDurationMin: 0, extraPrice: 0 };

export async function resolveAddOns(
  shopId: string,
  serviceId: string,
  addOnIds: string[] | undefined,
): Promise<ResolvedAddOns> {
  if (!addOnIds || addOnIds.length === 0) return NO_ADD_ONS;
  // De-dup so the same add-on picked twice can't double-charge.
  const ids = [...new Set(addOnIds)];
  const rows = await forShop(shopId).serviceAddOn.findMany({
    where: { id: { in: ids }, active: true },
    select: { id: true, name: true, durationMin: true, price: true, serviceIds: true },
  });

  let extraDurationMin = 0;
  let extraPrice = 0;
  const snapshot: AddOnSnapshotItem[] = rows
    .filter((r) => addOnOffersService(r, serviceId))
    .map((r) => {
      const price = r.price === null ? null : Number(r.price);
      extraDurationMin += r.durationMin;
      if (price !== null) extraPrice += price;
      return { id: r.id, name: r.name, durationMin: r.durationMin, price };
    });
  return { snapshot, extraDurationMin, extraPrice };
}

/**
 * Does the resolved set carry EVERY add-on that was asked for (repeats
 * counted once)? False when any id was another service's, another shop's,
 * switched off, made up - or when the caller resolved none at all because the
 * booking cannot take add-ons (a repeating series).
 *
 * The barber's form refuses on false rather than dropping: he was shown a
 * total with that add-on in it, and a quiet drop would book a shorter, cheaper
 * appointment than the one on his screen.
 */
export function keepsEveryAddOn(
  addOnIds: string[] | undefined,
  resolved: ResolvedAddOns,
): boolean {
  return new Set(addOnIds ?? []).size === resolved.snapshot.length;
}
