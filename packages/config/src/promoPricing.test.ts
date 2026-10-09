import { describe, expect, it } from "vitest";
import {
  applyPromo,
  isValidDiscount,
  normalizePromoCode,
  promoWindowOpen,
  promotionDiscount,
  PROMO_AMOUNT_MAX_CENTS,
  type PromoLine,
} from "./promoPricing.js";

const svc = (cents: number): PromoLine => ({ cents, eligible: true });
const addOn = (cents: number, eligible: boolean): PromoLine => ({ cents, eligible });

describe("applyPromo", () => {
  it("takes a percentage off the eligible subtotal", () => {
    expect(applyPromo([svc(3500)], { kind: "percent", bps: 2000 })).toEqual({
      subtotalCents: 3500,
      discountCents: 700,
      totalCents: 2800,
      lineDiscountCents: [700],
    });
  });

  it("🔴 rounds DOWN to the cent - never more off than the offer says", () => {
    // 15% of $33.33 is $4.9995.
    const r = applyPromo([svc(3333)], { kind: "percent", bps: 1500 });
    expect(r.discountCents).toBe(499);
    expect(r.totalCents).toBe(2834);
  });

  it("🔴 a fixed amount never takes the total below $0", () => {
    expect(applyPromo([svc(800)], { kind: "amount", cents: 1000 })).toMatchObject({
      discountCents: 800,
      totalCents: 0,
    });
  });

  it("🔴 lines the offer does not cover are never discounted", () => {
    const lines = [svc(3000), addOn(1000, false)];
    const pct = applyPromo(lines, { kind: "percent", bps: 5000 });
    expect(pct).toMatchObject({ discountCents: 1500, totalCents: 2500, lineDiscountCents: [1500, 0] });
    const amt = applyPromo(lines, { kind: "amount", cents: 5000 });
    expect(amt).toMatchObject({ discountCents: 3000, totalCents: 1000, lineDiscountCents: [3000, 0] });
  });

  it("covers add-ons when the shop includes them", () => {
    const r = applyPromo([svc(3000), addOn(1000, true)], { kind: "percent", bps: 5000 });
    expect(r).toMatchObject({ discountCents: 2000, totalCents: 2000, lineDiscountCents: [1500, 500] });
  });

  it("spreads an amount over the lines in proportion", () => {
    const r = applyPromo([svc(3000), addOn(1000, true)], { kind: "amount", cents: 500 });
    expect(r.lineDiscountCents).toEqual([375, 125]);
  });

  it("🔴 the line shares always add up to the discount exactly", () => {
    // A third off three equal lines: 999 off, which does not split evenly.
    const r = applyPromo([svc(1000), svc(1000), svc(1000)], { kind: "percent", bps: 3333 });
    expect(r.discountCents).toBe(999);
    expect(r.lineDiscountCents).toEqual([333, 333, 333]);
    const odd = applyPromo([svc(1001), svc(1000), svc(999)], { kind: "amount", cents: 1000 });
    expect(odd.lineDiscountCents.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(odd.lineDiscountCents).toEqual([334, 333, 333]);
    // The leftover cent goes to the share it rounds closest to (666.67), not
    // to whichever line comes first.
    const near = applyPromo([svc(1000), svc(2000)], { kind: "amount", cents: 1000 });
    expect(near.lineDiscountCents).toEqual([333, 667]);
  });

  it("🔴 for any ticket: shares sum exactly, no line below $0, total never negative", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let t = 0; t < 2000; t++) {
      const lines: PromoLine[] = Array.from({ length: 1 + rand(4) }, () => ({
        cents: rand(20_000),
        eligible: rand(3) !== 0,
      }));
      const discount =
        rand(2) === 0
          ? ({ kind: "percent", bps: 1 + rand(10_000) } as const)
          : ({ kind: "amount", cents: 1 + rand(30_000) } as const);
      const r = applyPromo(lines, discount);
      expect(r.lineDiscountCents.reduce((a, b) => a + b, 0)).toBe(r.discountCents);
      r.lineDiscountCents.forEach((d, i) => {
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(lines[i]!.eligible ? lines[i]!.cents : 0);
      });
      expect(r.totalCents).toBeGreaterThanOrEqual(0);
      expect(r.totalCents).toBe(r.subtotalCents - r.discountCents);
    }
  });

  it("nothing eligible, or a $0 ticket: nothing off", () => {
    expect(applyPromo([addOn(1000, false)], { kind: "percent", bps: 5000 }).discountCents).toBe(0);
    expect(applyPromo([svc(0)], { kind: "amount", cents: 500 })).toMatchObject({ discountCents: 0, totalCents: 0 });
    expect(applyPromo([], { kind: "amount", cents: 500 }).totalCents).toBe(0);
  });

  it("100% off leaves only what the offer does not cover", () => {
    expect(applyPromo([svc(3000), addOn(700, false)], { kind: "percent", bps: 10_000 }).totalCents).toBe(700);
  });

  it("🔴 refuses input that can only be a bug, rather than charging full price quietly", () => {
    expect(() => applyPromo([svc(10.5)], { kind: "percent", bps: 1000 })).toThrow(RangeError);
    expect(() => applyPromo([svc(-1)], { kind: "percent", bps: 1000 })).toThrow(RangeError);
    expect(() => applyPromo([svc(1000)], { kind: "percent", bps: 0 })).toThrow(RangeError);
    expect(() => applyPromo([svc(1000)], { kind: "amount", cents: 0 })).toThrow(RangeError);
  });
});

describe("isValidDiscount", () => {
  it("accepts 0.01% to 100%, and $0.01 to the cap", () => {
    expect(isValidDiscount({ kind: "percent", bps: 1 })).toBe(true);
    expect(isValidDiscount({ kind: "percent", bps: 10_000 })).toBe(true);
    expect(isValidDiscount({ kind: "amount", cents: PROMO_AMOUNT_MAX_CENTS })).toBe(true);
  });
  it("refuses everything else", () => {
    for (const bad of [
      null,
      "20%",
      { kind: "percent", bps: 0 },
      { kind: "percent", bps: 10_001 },
      { kind: "percent", bps: 12.5 },
      { kind: "amount", cents: 0 },
      { kind: "amount", cents: PROMO_AMOUNT_MAX_CENTS + 1 },
      { kind: "amount", cents: 1.5 },
      { kind: "free", cents: 100 },
    ]) {
      expect(isValidDiscount(bad)).toBe(false);
    }
  });
});

describe("normalizePromoCode", () => {
  it("case and surrounding spaces never matter", () => {
    expect(normalizePromoCode("  spooky25 ")).toBe("SPOOKY25");
    expect(normalizePromoCode("Fall-Deal")).toBe("FALL-DEAL");
  });
  it("is not a code: inner spaces, symbols, emoji, too short or long, not text", () => {
    for (const bad of ["a b c", "SAVE$5", "🎃🎃🎃", "AB", "X".repeat(25), "", 123, null]) {
      expect(normalizePromoCode(bad)).toBeNull();
    }
  });
});

describe("promotionDiscount (the existing Promotion table)", () => {
  it("PERCENT_OFF's whole percent becomes basis points", () => {
    expect(promotionDiscount({ kind: "PERCENT_OFF", percentOff: 20, amountOff: null })).toEqual({ kind: "percent", bps: 2000 });
  });
  it("🔴 AMOUNT_OFF's dollars become exact cents - no float drift", () => {
    expect(promotionDiscount({ kind: "AMOUNT_OFF", percentOff: null, amountOff: "12.50" })).toEqual({ kind: "amount", cents: 1250 });
    expect(promotionDiscount({ kind: "AMOUNT_OFF", percentOff: null, amountOff: "0.29" })).toEqual({ kind: "amount", cents: 29 });
    expect(promotionDiscount({ kind: "AMOUNT_OFF", percentOff: null, amountOff: 5 })).toEqual({ kind: "amount", cents: 500 });
    expect(promotionDiscount({ kind: "AMOUNT_OFF", percentOff: null, amountOff: "5.5" })).toEqual({ kind: "amount", cents: 550 });
  });
  it("🔴 not money off, or numbers that make no valid discount: null, never a guess", () => {
    for (const p of [
      { kind: "FREE_ADDON", percentOff: null, amountOff: null },
      { kind: "EXTRA_PUNCHES", percentOff: null, amountOff: null },
      { kind: "PERCENT_OFF", percentOff: null, amountOff: null },
      { kind: "PERCENT_OFF", percentOff: 0, amountOff: null },
      { kind: "PERCENT_OFF", percentOff: 101, amountOff: null },
      { kind: "AMOUNT_OFF", percentOff: null, amountOff: "0.00" },
      { kind: "AMOUNT_OFF", percentOff: null, amountOff: "-5" },
      { kind: "AMOUNT_OFF", percentOff: null, amountOff: "5.555" },
      { kind: "AMOUNT_OFF", percentOff: null, amountOff: "abc" },
    ]) {
      expect(promotionDiscount(p)).toBeNull();
    }
  });
});

describe("promoWindowOpen", () => {
  const at = new Date("2030-10-31T12:00:00Z");
  it("open-ended at either end", () => {
    expect(promoWindowOpen({ startsAt: null, endsAt: null }, at)).toBe(true);
  });
  it("starts inclusive, ends exclusive", () => {
    expect(promoWindowOpen({ startsAt: at, endsAt: null }, at)).toBe(true);
    expect(promoWindowOpen({ startsAt: null, endsAt: at }, at)).toBe(false);
    expect(promoWindowOpen({ startsAt: new Date(at.getTime() + 1), endsAt: null }, at)).toBe(false);
  });
});
