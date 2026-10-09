/**
 * WHAT A BOOKING COSTS AFTER IT MOVES.
 *
 * Both reschedule routes used to re-measure the price from the service's menu
 * for the new time and overwrite `priceAtBooking` with it. That silently threw
 * away everything the booking's price carried that the menu doesn't: its
 * add-ons, a special's price, a price the barber typed, a price edited by hand
 * (and recorded in the ledger), and any discount. A customer who booked
 * "Haircut + Beard, $50" and moved it a day was charged $40 at the chair with
 * nothing to say why.
 *
 * The rule, in two halves:
 *
 *  - A price the shop and client AGREED is attached to the booking and moves
 *    with it: a hand edit (there is a ledger row), a typed price, a discount -
 *    anything that is not simply the menu's figure for the old time. Add-ons
 *    always move with it, at their booked prices.
 *  - A MENU price may change with the time (a Sunday surcharge, an evening
 *    window, a date override), and a special's price belongs to the special
 *    being left. That repricing is permitted, but never silent: the route must
 *    show the new figure before the move and record it in the price ledger
 *    (`AppointmentPriceChange`), the same history a hand edit writes.
 *
 * Pure. The routes gather the facts and act on the answer.
 */

export interface MovePriceFacts {
  /** `priceAtBooking`, in cents. Null = the booking was never priced. */
  bookedCents: number | null;
  /** The booked add-ons' prices, summed (from the row's own snapshot). */
  addOnCents: number;
  /** The service's menu price for the OLD time, by the same rules create used. */
  menuAtOldCents: number | null;
  /** The service's menu price for the NEW time. */
  menuAtNewCents: number | null;
  /** The ledger has a row for this booking: a person set this price. */
  handEdited: boolean;
  /** Booked into a special (`bookedVia === "targeted_slot"`): leaving it. */
  special: boolean;
  /** An offer discounted this booking (its own engine re-applies it). */
  discounted: boolean;
}

export type MovePrice =
  /** An agreed price: it moves with the booking, untouched. */
  | { kind: "kept"; totalCents: number | null }
  /** A menu price, and the menu says the same at the new time. */
  | { kind: "same"; totalCents: number | null }
  /** A menu price that differs at the new time: say so, get a yes, record it. */
  | { kind: "changes"; fromCents: number | null; toCents: number };

export function movePrice(f: MovePriceFacts): MovePrice {
  if (f.bookedCents === null) return { kind: "kept", totalCents: null };
  if (f.handEdited || f.discounted) return { kind: "kept", totalCents: f.bookedCents };
  const bookedBase = f.bookedCents - f.addOnCents;
  // Not the menu's own figure for when it was booked (typed, or a price the
  // menu no longer explains): agreed, so it stays.
  if (!f.special && bookedBase !== (f.menuAtOldCents ?? 0)) {
    return { kind: "kept", totalCents: f.bookedCents };
  }
  // A special with no menu price to fall back to keeps what it was booked at.
  if (f.menuAtNewCents === null && f.special) return { kind: "kept", totalCents: f.bookedCents };
  const toCents = (f.menuAtNewCents ?? 0) + f.addOnCents;
  if (toCents === f.bookedCents) return { kind: "same", totalCents: f.bookedCents };
  return { kind: "changes", fromCents: f.bookedCents, toCents };
}

/** The add-ons a row was booked with, summed in cents, from its own snapshot. */
export function addOnCentsOf(snapshot: unknown): number {
  if (!Array.isArray(snapshot)) return 0;
  let cents = 0;
  for (const item of snapshot) {
    const price = (item as { price?: unknown })?.price;
    if (typeof price === "number" && Number.isFinite(price)) cents += Math.round(price * 100);
  }
  return cents;
}

export function dollarsToCents(value: { toString(): string } | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value.toString());
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
