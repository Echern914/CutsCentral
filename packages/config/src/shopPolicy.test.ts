import { describe, expect, it } from "vitest";
import {
  describeCancellationPolicy,
  describeDepositPolicy,
  describeShopPolicy,
  type ShopPolicyInput,
} from "./shopPolicy.js";

const base: ShopPolicyInput = {
  paymentsMode: "off",
  cancelWindowHours: 0,
  cancelFeeBps: 0,
  depositAmountCents: null,
};

describe("describeCancellationPolicy", () => {
  it("needs BOTH a window and a rate before it is a fee", () => {
    expect(describeCancellationPolicy(base)).toBe(
      "free cancellation any time before the appointment",
    );
    // A window with no rate, or a rate with no window, is still free — that is
    // what the shop configured, so it is what we must say.
    expect(describeCancellationPolicy({ ...base, cancelWindowHours: 12 })).toBe(
      "free cancellation any time before the appointment",
    );
    expect(describeCancellationPolicy({ ...base, cancelFeeBps: 5000 })).toBe(
      "free cancellation any time before the appointment",
    );
  });

  it("states the window and the percentage when both are set", () => {
    expect(
      describeCancellationPolicy({ ...base, cancelWindowHours: 12, cancelFeeBps: 5000 }),
    ).toBe("free up to 12h before; inside that window 50% of the price is kept as a fee");
  });

  it("🔴 does not round a fractional percentage away", () => {
    // The old formatter used .toFixed(0), turning a 40.5% fee into "41%" — a
    // number the shop never chose, quoted to a customer as policy.
    expect(
      describeCancellationPolicy({ ...base, cancelWindowHours: 24, cancelFeeBps: 4050 }),
    ).toContain("40.5%");
    expect(
      describeCancellationPolicy({ ...base, cancelWindowHours: 24, cancelFeeBps: 10000 }),
    ).toContain("100%");
  });
});

describe("describeDepositPolicy", () => {
  it("🔴 DEPOSIT MODE IS NOT 'pay at the shop' — the defect this file fixes", () => {
    // The original chain tested only "ahead" and "hold", so a deposit shop
    // fell through to the off-mode string: the receptionist told callers
    // there was no deposit while the booking page charged one.
    const deposit = describeDepositPolicy({
      ...base,
      paymentsMode: "deposit",
      depositAmountCents: 2000,
    });
    expect(deposit).toBe("$20 deposit collected at booking, the rest at the shop");
    expect(deposit).not.toContain("pay at the shop.");
    expect(deposit).not.toContain("none");
  });

  it("says 'a deposit' rather than inventing an amount when none is set", () => {
    expect(
      describeDepositPolicy({ ...base, paymentsMode: "deposit", depositAmountCents: null }),
    ).toBe("a deposit collected at booking, the rest at the shop");
  });

  it("formats cents that are not whole dollars", () => {
    expect(
      describeDepositPolicy({ ...base, paymentsMode: "deposit", depositAmountCents: 1550 }),
    ).toContain("$15.50");
  });

  it("answers for card-present rather than falling through", () => {
    // `terminal` is documented as never being a shop setting, but the DB enum
    // permits it. A total function has to have an answer; the honest one is
    // that card-present is still paying at the shop.
    expect(describeDepositPolicy({ ...base, paymentsMode: "terminal" })).toBe(
      "none - pay at the shop",
    );
  });

  it("covers the other three modes", () => {
    expect(describeDepositPolicy({ ...base, paymentsMode: "ahead" })).toBe(
      "full payment collected at booking time",
    );
    expect(describeDepositPolicy({ ...base, paymentsMode: "hold" })).toBe(
      "card authorized at booking, charged after the appointment",
    );
    expect(describeDepositPolicy(base)).toBe("none - pay at the shop");
  });
});

describe("describeShopPolicy", () => {
  it("leads with the shop's own numbers", () => {
    const line = describeShopPolicy({
      paymentsMode: "deposit",
      cancelWindowHours: 24,
      cancelFeeBps: 10000,
      depositAmountCents: 2000,
    });
    expect(line).toContain("free up to 24h before");
    expect(line).toContain("100%");
    expect(line).toContain("$20 deposit");
  });

  it("🔴 warns when a configured fee cannot actually be charged", () => {
    // Payments off + a fee configured = an inert rule. Quoting the fee without
    // saying so is true and misleading at the same time.
    const line = describeShopPolicy({
      ...base,
      cancelWindowHours: 24,
      cancelFeeBps: 5000,
    });
    expect(line).toContain("cannot actually be charged");
  });

  it("does not add the warning when payments are on, or when there is no fee", () => {
    expect(
      describeShopPolicy({
        paymentsMode: "ahead",
        cancelWindowHours: 24,
        cancelFeeBps: 5000,
        depositAmountCents: null,
      }),
    ).not.toContain("cannot actually be charged");
    expect(describeShopPolicy(base)).not.toContain("cannot actually be charged");
  });
});
