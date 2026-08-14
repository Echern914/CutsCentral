import { describe, expect, it } from "vitest";
import { depositChargeCents, toCents } from "./payments.js";

/**
 * The deposit is the one number in the product a customer sees charged to their
 * card before they have received anything, so every way it could be WRONG is
 * pinned here:
 *   - charging MORE than the service costs (a shop-wide $20 on a $15 line-up),
 *   - charging something when the shop never configured an amount,
 *   - charging something for a service with no price.
 * In all three the right answer is "take nothing and let them pay in person" —
 * a surprise card charge is far worse than a missed deposit.
 */
describe("depositChargeCents", () => {
  it("charges the deposit when it is less than the price", () => {
    expect(depositChargeCents(2000, toCents(45))).toBe(2000);
  });

  it("CAPS at the service price - never overcharges a cheap service", () => {
    // $20 deposit, $15 line-up -> charge $15, not $20.
    expect(depositChargeCents(2000, toCents(15))).toBe(1500);
  });

  it("charges the price exactly when they are equal", () => {
    expect(depositChargeCents(2000, toCents(20))).toBe(2000);
  });

  it("charges NOTHING when the shop never set an amount", () => {
    // Deposit mode switched on, amount left null - take nothing rather than
    // invent a number.
    expect(depositChargeCents(null, toCents(45))).toBeNull();
    expect(depositChargeCents(undefined, toCents(45))).toBeNull();
  });

  it("charges NOTHING for a zero or negative deposit", () => {
    expect(depositChargeCents(0, toCents(45))).toBeNull();
    expect(depositChargeCents(-500, toCents(45))).toBeNull();
  });

  it("charges NOTHING for an unpriced service", () => {
    // "Consultation" with no price: there is nothing to take a deposit against.
    expect(depositChargeCents(2000, null)).toBeNull();
    expect(depositChargeCents(2000, toCents(0))).toBeNull();
  });

  it("keeps cent precision on an odd price", () => {
    // $12.50 service, $20 deposit -> capped to exactly 1250, not 1249/1251.
    expect(depositChargeCents(2000, toCents(12.5))).toBe(1250);
  });
});
