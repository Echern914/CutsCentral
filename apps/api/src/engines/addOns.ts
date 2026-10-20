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
 * into endsAt and `extraPrice` into priceAtBooking at create time. The barber's
 * edit sheet changes a booking's set through `resolveEditedAddOns` below.
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

/** A booking's frozen add-ons, read defensively off its JSON column. */
export function snapshotOf(raw: unknown): AddOnSnapshotItem[] {
  if (!Array.isArray(raw)) return [];
  const out: AddOnSnapshotItem[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { id, name, durationMin, price } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string") continue;
    out.push({
      id,
      name,
      durationMin: typeof durationMin === "number" && Number.isFinite(durationMin) ? durationMin : 0,
      price: typeof price === "number" && Number.isFinite(price) ? price : null,
    });
  }
  return out;
}

/** Minutes and cents a snapshot adds to a booking. */
export function addOnTotals(snapshot: AddOnSnapshotItem[]): { minutes: number; cents: number } {
  let minutes = 0;
  let cents = 0;
  for (const a of snapshot) {
    minutes += a.durationMin;
    if (a.price !== null) cents += Math.round(a.price * 100);
  }
  return { minutes, cents };
}

export type EditedAddOns =
  | {
      ok: true;
      /** What to write to Appointment.addOns when `changed`. */
      snapshot: unknown[];
      changed: boolean;
      /** Minutes and cents the add-ons added before and after this edit. */
      before: { minutes: number; cents: number };
      after: { minutes: number; cents: number };
    }
  | { ok: false; message: string };

/**
 * THE ADD-ONS A BOOKING CARRIES AFTER AN EDIT (the barber's edit sheet).
 *
 *  - `addOnIds` absent: the booking keeps what it has. If the SERVICE changes,
 *    every one of them must still be offered with the new service, or the edit
 *    is refused by name - never silently dropped (the sheet drops them
 *    visibly, before save, and sends the shorter list).
 *  - `addOnIds` given: the full new set ([] removes them all). An add-on the
 *    booking ALREADY carries keeps its frozen snapshot - its price and minutes
 *    as booked, even if the shop has since repriced it - so keeping it never
 *    re-prices the visit. Only a NEWLY added one is resolved, by the same
 *    `resolveAddOns` the create path uses, and refused (`keepsEveryAddOn`)
 *    rather than dropped. On a service change the kept ones are re-checked
 *    against the new service too.
 *
 * Items without an id (a walk-in queue visit's extra services ride in the same
 * column - engines/walkInStart.ts) cannot be picked or unpicked here: they are
 * carried through untouched and count on neither side of the change.
 */
export async function resolveEditedAddOns(
  shopId: string,
  input: {
    /** The booking's Appointment.addOns column, as read. */
    current: unknown;
    /** The booking's service after this edit. */
    serviceId: string;
    serviceChanged: boolean;
    addOnIds: string[] | undefined;
  },
): Promise<EditedAddOns> {
  const { serviceId, serviceChanged } = input;
  const current = snapshotOf(input.current);
  const before = addOnTotals(current);
  const pinned = Array.isArray(input.current)
    ? input.current.filter((item) => typeof (item as { id?: unknown } | null)?.id !== "string")
    : [];
  if (input.addOnIds === undefined && !serviceChanged) {
    return { ok: true, snapshot: [...pinned, ...current], changed: false, before, after: before };
  }
  const requested = [...new Set(input.addOnIds ?? current.map((a) => a.id))];
  const currentIds = new Set(current.map((a) => a.id));
  const kept = current.filter((a) => requested.includes(a.id));
  const added = requested.filter((id) => !currentIds.has(id));
  const toCheck = serviceChanged ? requested : added;
  const resolved = await resolveAddOns(shopId, serviceId, toCheck);
  if (!keepsEveryAddOn(toCheck, resolved)) {
    const honoured = new Set(resolved.snapshot.map((a) => a.id));
    const refusedNames = kept.filter((a) => !honoured.has(a.id)).map((a) => a.name);
    const unnamed = added.some((id) => !honoured.has(id));
    return {
      ok: false,
      message:
        refusedNames.length > 0 && !unnamed
          ? `${refusedNames.join(" and ")} ${refusedNames.length === 1 ? "isn't" : "aren't"} offered with this service. Remove ${refusedNames.length === 1 ? "it" : "them"}, or keep the old service.`
          : "An add-on you picked isn't offered with this service any more. Close this and open it again to see the current list.",
    };
  }
  const fresh = resolved.snapshot.filter((a) => !currentIds.has(a.id));
  const next = [...kept, ...fresh];
  const changed = next.length !== current.length || next.some((a) => !currentIds.has(a.id));
  return {
    ok: true,
    snapshot: [...pinned, ...next],
    changed,
    before,
    after: addOnTotals(next),
  };
}
