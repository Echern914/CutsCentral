import { describe, expect, it } from "vitest";
import {
  describeLateCancelCardOutcome,
  describeLateCancelChargeResult,
  lateCancelAsksFirst,
  lateCancelCardOutcome,
  type CancellationTerms,
} from "./shopPolicy.js";

/**
 * What the barber's Cancel says it will do to the card when the CLIENT
 * cancelled late (by text or a call, never touching their link). It offers a
 * fee only where settleCardOnFile would charge one: card fees on in THIS
 * booking's terms, inside the window, a saved card, a fee above zero. Every
 * other case names the one reason, so "the click did nothing" never happens
 * silently.
 */
const ON: CancellationTerms = {
  cancelWindowHours: 24,
  cancelFeeBps: 5000,
  chargeCardOnFileFees: true,
  cardFeeFlatCents: null,
};
const OFF: CancellationTerms = { ...ON, chargeCardOnFileFees: false };

// A fixed instant; the appointment is 3 hours after it (inside a 24h window).
const NOW = new Date("2026-09-23T16:00:00.000Z");
const IN_3H = new Date(NOW.getTime() + 3 * 3_600_000);
const IN_3_DAYS = new Date(NOW.getTime() + 72 * 3_600_000);

const base = {
  cardStatus: "saved",
  last4: "4242",
  feeCents: 2000,
  terms: ON,
  shopFeesOnNow: true,
  startsAt: IN_3H,
  now: NOW,
};

describe("lateCancelCardOutcome", () => {
  it("inside the window, a saved card, a fee due: the charge, with the card", () => {
    const o = lateCancelCardOutcome(base);
    expect(o).toEqual({ charge: true, cents: 2000, last4: "4242" });
    expect(describeLateCancelCardOutcome(o).text).toBe("Charges a $20 late-cancel fee to the card ending 4242.");
  });

  it("🔴 booked before fees were turned on: never a charge, and it says so", () => {
    const o = lateCancelCardOutcome({ ...base, terms: OFF, feeCents: 0 });
    expect(o).toEqual({ charge: false, reason: "booked_before_fees", windowHours: 24 });
    expect(describeLateCancelCardOutcome(o).text).toMatch(/booked before you turned on card fees/);
  });

  it("fees off today and on this booking: fees_off, with the way to the setting", () => {
    const o = lateCancelCardOutcome({ ...base, terms: OFF, feeCents: 0, shopFeesOnNow: false });
    expect(o).toEqual({ charge: false, reason: "fees_off", windowHours: 24 });
    expect(describeLateCancelCardOutcome(o).settingsLink).toBe(true);
  });

  it("fees on but no amount set", () => {
    const o = lateCancelCardOutcome({ ...base, terms: { ...ON, cancelFeeBps: 0 }, feeCents: 0 });
    expect(o).toMatchObject({ charge: false, reason: "no_fee_set" });
    expect(describeLateCancelCardOutcome(o).settingsLink).toBe(true);
  });

  it("no cancellation window: only a no-show is charged", () => {
    const o = lateCancelCardOutcome({ ...base, terms: { ...ON, cancelWindowHours: 0 }, feeCents: 0 });
    expect(o).toMatchObject({ charge: false, reason: "no_window" });
  });

  it("🔴 more than the window ahead: free to cancel, and it names the hours", () => {
    const o = lateCancelCardOutcome({ ...base, startsAt: IN_3_DAYS, feeCents: 0 });
    expect(o).toEqual({ charge: false, reason: "outside_window", windowHours: 24 });
    expect(describeLateCancelCardOutcome(o).text).toMatch(/more than 24 hours before/);
  });

  it("no price: the fee comes to $0", () => {
    expect(lateCancelCardOutcome({ ...base, feeCents: 0 })).toMatchObject({ charge: false, reason: "no_price" });
  });

  it("the card: none saved, let go, declined, or a charge running - each named", () => {
    const at = (cardStatus: string | null) => lateCancelCardOutcome({ ...base, cardStatus });
    expect(at(null)).toMatchObject({ reason: "no_card" });
    expect(at("pending")).toMatchObject({ reason: "no_card" });
    expect(at("released")).toMatchObject({ reason: "card_released" });
    expect(at("charged")).toMatchObject({ reason: "card_released" });
    expect(at("failed")).toMatchObject({ reason: "already_declined" });
    expect(at("charging")).toMatchObject({ reason: "charge_in_progress" });
  });

  it("no last4: still names the card, never 'ending null'", () => {
    const o = lateCancelCardOutcome({ ...base, last4: null });
    expect(describeLateCancelCardOutcome(o).text).toBe(
      "Charges a $20 late-cancel fee to the card saved on this booking.",
    );
  });
});

describe("lateCancelAsksFirst", () => {
  it("asks when a fee is due, and when fees are on but nothing can be charged", () => {
    expect(lateCancelAsksFirst(lateCancelCardOutcome(base))).toBe(true);
    expect(lateCancelAsksFirst(lateCancelCardOutcome({ ...base, cardStatus: "released" }))).toBe(true);
    expect(lateCancelAsksFirst(lateCancelCardOutcome({ ...base, startsAt: IN_3_DAYS }))).toBe(true);
    expect(lateCancelAsksFirst(lateCancelCardOutcome({ ...base, terms: OFF, feeCents: 0 }))).toBe(true);
  });

  it("a shop with card fees off keeps Cancel one tap", () => {
    expect(
      lateCancelAsksFirst(lateCancelCardOutcome({ ...base, terms: OFF, feeCents: 0, shopFeesOnNow: false })),
    ).toBe(false);
    expect(lateCancelAsksFirst(null)).toBe(false);
    expect(lateCancelAsksFirst(undefined)).toBe(false);
  });
});

describe("describeLateCancelChargeResult", () => {
  it("charged: the amount and the card, as proof", () => {
    expect(describeLateCancelChargeResult({ kind: "charged", cents: 2000 }, "4242")).toEqual({
      text: "Charged a $20 late-cancel fee to the card ending 4242.",
      tone: "good",
    });
  });

  it("not charged: late-cancel words, never no-show words", () => {
    const said = describeLateCancelChargeResult({ kind: "not_charged", why: "no_fee_due" }, "4242");
    expect(said.text).toMatch(/no late-cancel fee was due/);
    expect(said.text).not.toMatch(/no-show/i);
  });

  it("🔴 a decline is never reported as a charge", () => {
    const said = describeLateCancelChargeResult({ kind: "declined", cents: 2000, code: null }, "4242");
    expect(said.tone).not.toBe("good");
    expect(said.text).not.toMatch(/^Charged/);
  });
});
