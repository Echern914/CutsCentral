import { describe, expect, it } from "vitest";
import { addOnCentsOf, dollarsToCents, movePrice, type MovePriceFacts } from "./movePrice.js";

/**
 * What a booking costs after it moves (engines/movePrice.ts).
 *
 * The two halves of the rule: an AGREED price moves with the booking; a MENU
 * price may change with the time, but only as a "changes" answer the route
 * must show and record.
 */
const menu = (over: Partial<MovePriceFacts> = {}): MovePriceFacts => ({
  bookedCents: 4000,
  addOnCents: 0,
  menuAtOldCents: 4000,
  menuAtNewCents: 4000,
  handEdited: false,
  special: false,
  discounted: false,
  ...over,
});

describe("an agreed price moves with the booking", () => {
  it("🔴 add-ons: Haircut $40 + Beard $10, booked $50, moved to a $45 Sunday - stays $50? No: the base is menu, so it changes to $55, add-ons kept", () => {
    expect(movePrice(menu({ bookedCents: 5000, addOnCents: 1000, menuAtNewCents: 4500 }))).toEqual({
      kind: "changes",
      fromCents: 5000,
      toCents: 5500,
    });
  });

  it("🔴 add-ons on a same-price day: nothing changes, and the add-ons are still in the total", () => {
    expect(movePrice(menu({ bookedCents: 5000, addOnCents: 1000 }))).toEqual({ kind: "same", totalCents: 5000 });
  });

  it("🔴 a typed price (not the menu's figure for the old time) stays, whatever the new day's menu says", () => {
    expect(movePrice(menu({ bookedCents: 3000, menuAtNewCents: 4500 }))).toEqual({ kind: "kept", totalCents: 3000 });
  });

  it("🔴 a hand-edited price stays even when it happens to equal the old menu", () => {
    expect(movePrice(menu({ handEdited: true, menuAtNewCents: 4500 }))).toEqual({ kind: "kept", totalCents: 4000 });
  });

  it("a discounted booking is the offer engine's to re-price: kept here", () => {
    expect(movePrice(menu({ bookedCents: 3000, discounted: true, menuAtNewCents: 4500 }))).toEqual({ kind: "kept", totalCents: 3000 });
  });

  it("an unpriced booking stays unpriced", () => {
    expect(movePrice(menu({ bookedCents: null, menuAtNewCents: 4500 }))).toEqual({ kind: "kept", totalCents: null });
  });
});

describe("a menu price may change, but says so", () => {
  it("🔴 a plain menu booking moved to a Sunday surcharge: changes $40 -> $45", () => {
    expect(movePrice(menu({ menuAtNewCents: 4500 }))).toEqual({ kind: "changes", fromCents: 4000, toCents: 4500 });
  });

  it("…and down: $40 -> $35 is also a change the client sees", () => {
    expect(movePrice(menu({ menuAtNewCents: 3500 }))).toEqual({ kind: "changes", fromCents: 4000, toCents: 3500 });
  });

  it("🔴 leaving a special: its price goes, the menu price for the new time is offered", () => {
    expect(movePrice(menu({ bookedCents: 15000, special: true, menuAtOldCents: 12000, menuAtNewCents: 12000 }))).toEqual({
      kind: "changes",
      fromCents: 15000,
      toCents: 12000,
    });
  });

  it("a special on a service the menu no longer prices keeps what it was booked at", () => {
    expect(movePrice(menu({ bookedCents: 15000, special: true, menuAtOldCents: null, menuAtNewCents: null }))).toEqual({
      kind: "kept",
      totalCents: 15000,
    });
  });

  it("a menu booking of an unpriced service that gains a price: offered, not imposed", () => {
    expect(movePrice(menu({ bookedCents: 0, menuAtOldCents: null, menuAtNewCents: 2000 }))).toEqual({
      kind: "changes",
      fromCents: 0,
      toCents: 2000,
    });
  });
});

describe("the helpers", () => {
  it("sums the booked add-ons' prices from the row's own snapshot, in cents", () => {
    expect(addOnCentsOf([{ price: 10 }, { price: 2.5 }, { price: null }, {}])).toBe(1250);
    expect(addOnCentsOf(null)).toBe(0);
    expect(addOnCentsOf("not a list")).toBe(0);
  });

  it("reads a Prisma Decimal or a number as cents, exactly", () => {
    expect(dollarsToCents({ toString: () => "40.10" })).toBe(4010);
    expect(dollarsToCents(12.5)).toBe(1250);
    expect(dollarsToCents(null)).toBeNull();
  });
});
