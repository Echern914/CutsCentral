import { describe, expect, it } from "vitest";
import {
  describeNoShowCardOutcome,
  noShowCardOutcome,
  type CancellationTerms,
} from "./shopPolicy.js";

/**
 * What the barber is told a no-show does to the card, before it is marked.
 * Charged only where settleCardOnFile would charge: the live path, a saved
 * card, and a fee above zero on THIS booking's terms. Every other case names
 * the one reason - and never offers a figure it would not charge.
 */
const ON: CancellationTerms = {
  cancelWindowHours: 24,
  cancelFeeBps: 5000,
  chargeCardOnFileFees: true,
  cardFeeFlatCents: null,
};
const OFF: CancellationTerms = { ...ON, chargeCardOnFileFees: false };

const base = {
  path: "live" as const,
  cardStatus: "saved",
  last4: "4242",
  feeCents: 2000,
  terms: ON,
  shopFeesOnNow: true,
  depositKept: false,
};

describe("noShowCardOutcome", () => {
  it("live, a saved card, a fee on this booking's terms: the charge, with the card", () => {
    const o = noShowCardOutcome(base);
    expect(o).toEqual({ charge: true, cents: 2000, last4: "4242" });
    expect(describeNoShowCardOutcome(o).text).toBe("Charges $20 to the card ending 4242.");
  });

  it("🔴 booked while fees were off, switched on since: never a charge, and it says why", () => {
    const o = noShowCardOutcome({ ...base, terms: OFF, feeCents: 0, shopFeesOnNow: true });
    expect(o).toEqual({ charge: false, reason: "booked_before_fees" });
    expect(describeNoShowCardOutcome(o).text).toMatch(/booked before you turned on no-show fees/);
  });

  it("fees off today and on this booking: fees_off, with the way to the setting", () => {
    const o = noShowCardOutcome({ ...base, terms: OFF, feeCents: 0, shopFeesOnNow: false });
    expect(o).toEqual({ charge: false, reason: "fees_off" });
    expect(describeNoShowCardOutcome(o).settingsLink).toBe(true);
  });

  it("no card was saved (none, or the card step never finished)", () => {
    for (const cardStatus of [null, "pending", "failed"]) {
      expect(noShowCardOutcome({ ...base, cardStatus, feeCents: 2000 })).toEqual({
        charge: false,
        reason: "no_card",
      });
    }
  });

  it("a deposit collected at booking: kept, nothing more", () => {
    expect(noShowCardOutcome({ ...base, cardStatus: null, depositKept: true })).toEqual({
      charge: false,
      reason: "deposit_kept",
    });
  });

  it("fees on but no amount, or no price: nothing, and which", () => {
    expect(
      noShowCardOutcome({ ...base, terms: { ...ON, cancelFeeBps: 0 }, feeCents: 0 }),
    ).toEqual({ charge: false, reason: "no_fee_set" });
    expect(noShowCardOutcome({ ...base, feeCents: 0 })).toEqual({ charge: false, reason: "no_price" });
  });

  it("🔴 a visit the sweep already closed is never charged, even with a fee due", () => {
    expect(noShowCardOutcome({ ...base, path: "correction", cardStatus: "released" })).toEqual({
      charge: false,
      reason: "visit_closed",
    });
    // The correction path moves no money whatever the card says.
    expect(noShowCardOutcome({ ...base, path: "correction", cardStatus: "saved" }).charge).toBe(false);
  });

  it("a live booking whose card was already let go", () => {
    expect(noShowCardOutcome({ ...base, cardStatus: "released" })).toEqual({
      charge: false,
      reason: "card_released",
    });
  });

  it("every reason has a sentence", () => {
    for (const reason of [
      "deposit_kept",
      "fees_off",
      "booked_before_fees",
      "no_fee_set",
      "no_price",
      "no_card",
      "card_released",
      "visit_closed",
    ] as const) {
      expect(describeNoShowCardOutcome({ charge: false, reason }).text).toMatch(/^Nothing/);
    }
  });
});
