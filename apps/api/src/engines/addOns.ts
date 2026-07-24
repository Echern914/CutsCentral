import { forShop } from "@chairback/db";

/**
 * Resolve a set of chosen add-on ids into their snapshot + the extra duration
 * and price they contribute to an appointment. Only ACTIVE add-ons that belong
 * to the shop AND are valid for the service (shop-wide, serviceId null, OR
 * scoped to this exact service) are honored - anything else is silently dropped,
 * so a stale/crafted id can't inflate the price or grab a foreign add-on.
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

const EMPTY: ResolvedAddOns = { snapshot: [], extraDurationMin: 0, extraPrice: 0 };

export async function resolveAddOns(
  shopId: string,
  serviceId: string,
  addOnIds: string[] | undefined,
): Promise<ResolvedAddOns> {
  if (!addOnIds || addOnIds.length === 0) return EMPTY;
  // De-dup so the same add-on picked twice can't double-charge.
  const ids = [...new Set(addOnIds)];
  const rows = await forShop(shopId).serviceAddOn.findMany({
    where: {
      id: { in: ids },
      active: true,
      // valid for this service: shop-wide ([]) or scoped to a set holding it.
      OR: [{ serviceIds: { isEmpty: true } }, { serviceIds: { has: serviceId } }],
    },
    select: { id: true, name: true, durationMin: true, price: true },
  });

  let extraDurationMin = 0;
  let extraPrice = 0;
  const snapshot: AddOnSnapshotItem[] = rows.map((r) => {
    const price = r.price === null ? null : Number(r.price);
    extraDurationMin += r.durationMin;
    if (price !== null) extraPrice += price;
    return { id: r.id, name: r.name, durationMin: r.durationMin, price };
  });
  return { snapshot, extraDurationMin, extraPrice };
}
