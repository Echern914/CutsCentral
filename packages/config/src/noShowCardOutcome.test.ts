import { describe, expect, it } from "vitest";
import {
  cardDeclineWords,
  describeNoShowCardOutcome,
  describeNoShowChargeResult,
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
    for (const cardStatus of [null, "pending"]) {
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
      "already_declined",
      "charge_in_progress",
    ] as const) {
      expect(describeNoShowCardOutcome({ charge: false, reason }).text).toMatch(/^Nothing/);
    }
  });

  it("🔴 a card that was TRIED is not 'no card was saved'", () => {
    expect(noShowCardOutcome({ ...base, cardStatus: "failed" })).toEqual({ charge: false, reason: "already_declined" });
    expect(noShowCardOutcome({ ...base, cardStatus: "charging" })).toEqual({
      charge: false,
      reason: "charge_in_progress",
    });
    expect(noShowCardOutcome({ ...base, cardStatus: null })).toEqual({ charge: false, reason: "no_card" });
  });
});

/**
 * What the card DID, said after Mark no-show (Drick, 2026-10-22: the screen
 * said "Marked no-show" whatever happened, and a setup problem read as a
 * decline).
 */
describe("describeNoShowChargeResult", () => {
  it("charged: the amount and the card", () => {
    expect(describeNoShowChargeResult({ kind: "charged", cents: 2500 }, "4242")).toEqual({
      text: "Charged $25 to the card ending 4242.",
      tone: "good",
    });
    expect(describeNoShowChargeResult({ kind: "charged", cents: 2500 }, null).text).toBe(
      "Charged $25 to the saved card.",
    );
  });

  it("declined: why, in the bank's terms, and to collect it at the next visit", () => {
    const d = describeNoShowChargeResult({ kind: "declined", cents: 2000, code: "insufficient_funds" }, "4242");
    expect(d).toEqual({
      text: "The $20 fee was declined: not enough money on the card. Collect it at their next visit.",
      tone: "warn",
    });
  });

  it("🔴 a setup problem is never called a decline or sent to the next visit", () => {
    const d = describeNoShowChargeResult({ kind: "setup_problem", cents: 2000 }, "4242");
    expect(d.text).toMatch(/isn't the card/);
    expect(d.text).not.toMatch(/declined|next visit/);
    expect(d.tone).toBe("warn");
  });

  it("an answer still out says to wait before collecting", () => {
    expect(describeNoShowChargeResult({ kind: "pending", cents: 2000 }, null).text).toMatch(
      /before collecting anything/,
    );
  });

  it("nothing charged names the reason", () => {
    for (const why of ["fees_off", "no_fee_due", "no_card", "already"] as const) {
      expect(describeNoShowChargeResult({ kind: "not_charged", why }, null).text).toMatch(/^Nothing/);
    }
  });
});

describe("cardDeclineWords", () => {
  it("common codes read as words; unknown, missing and raw text read as a plain decline", () => {
    expect(cardDeclineWords("insufficient_funds")).toBe("not enough money on the card");
    expect(cardDeclineWords("expired_card")).toBe("the card has expired");
    expect(cardDeclineWords("authentication_required")).toMatch(/approve it themselves/);
    expect(cardDeclineWords("generic_decline")).toBe("the bank declined it");
    expect(cardDeclineWords("unknown")).toBe("the bank declined it");
    expect(cardDeclineWords(null)).toBe("the bank declined it");
    expect(cardDeclineWords("Your card number 4242 was declined.")).toBe("the bank declined it");
  });
});
