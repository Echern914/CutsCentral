import { describe, expect, it } from "vitest";
import { PLANS } from "./constants.js";
import {
  PARTNER_PROGRAM,
  PARTNER_QUALIFYING_PLANS,
  normalizePartnerCode,
  partnerBalance,
  partnerCashoutRefusal,
  partnerInvoiceQualifies,
  partnerUnlock,
  planMarginCents,
} from "./partnerProgram.js";

const DAY = 86_400_000;
const T0 = new Date("2026-08-01T15:00:00Z");
const day = (n: number, extraMs = 0) => new Date(T0.getTime() + n * DAY + extraMs);

describe("the cashout unlock policy", () => {
  it("is locked with no window before the first qualifying referral", () => {
    expect(partnerUnlock([], T0)).toEqual({ unlocked: false, unlockedAt: null, window: null });
  });

  it("opens the window at the FIRST qualifying referral and counts toward 5", () => {
    const u = partnerUnlock([day(0), day(10), day(20)], day(30));
    expect(u.unlocked).toBe(false);
    expect(u.window).toEqual({ opensAt: day(0), closesAt: day(90), count: 3, open: true });
  });

  it("unlocks when the 5th lands EXACTLY 90 days after the first", () => {
    const u = partnerUnlock([day(0), day(1), day(2), day(3), day(90)], day(90));
    expect(u).toEqual({ unlocked: true, unlockedAt: day(90), window: null });
  });

  it("does not unlock when the 5th lands on day 91 - it opens a new window", () => {
    const u = partnerUnlock([day(0), day(1), day(2), day(3), day(91)], day(91));
    expect(u.unlocked).toBe(false);
    expect(u.window).toEqual({ opensAt: day(91), closesAt: day(181), count: 1, open: true });
  });

  it("one millisecond past day 90 is outside the window", () => {
    const u = partnerUnlock([day(0), day(1), day(2), day(3), day(90, 1)], day(95));
    expect(u.unlocked).toBe(false);
    expect(u.window?.count).toBe(1);
  });

  it("reports a lapsed window as closed until the next referral", () => {
    const u = partnerUnlock([day(0), day(5)], day(91));
    expect(u.unlocked).toBe(false);
    expect(u.window).toEqual({ opensAt: day(0), closesAt: day(90), count: 2, open: false });
  });

  it("unlocks inside a LATER window after an earlier one lapsed", () => {
    const lapsed = [day(0), day(5), day(6)];
    const second = [day(100), day(110), day(120), day(130), day(189)];
    const u = partnerUnlock([...second, ...lapsed], day(200)); // any order
    expect(u).toEqual({ unlocked: true, unlockedAt: day(189), window: null });
  });

  it("stays unlocked for good - later gaps do not relock", () => {
    const five = [day(0), day(1), day(2), day(3), day(4)];
    expect(partnerUnlock([...five, day(400)], day(900)).unlocked).toBe(true);
  });
});

describe("balance: lapsed-window earnings are kept, locked, then released", () => {
  it("holds everything while locked and releases it all once unlocked", () => {
    expect(partnerBalance({ earnedCents: 1500, cashedOutCents: 0, unlocked: false })).toEqual({
      earnedCents: 1500,
      lockedCents: 1500,
      availableCents: 0,
    });
    expect(partnerBalance({ earnedCents: 4000, cashedOutCents: 2500, unlocked: true })).toEqual({
      earnedCents: 4000,
      lockedCents: 0,
      availableCents: 1500,
    });
  });
});

describe("cashout validation", () => {
  const ok = { unlocked: true, availableCents: 10_000 };
  it("allows only $25 and $50", () => {
    expect(partnerCashoutRefusal({ ...ok, amountCents: 2500 })).toBeNull();
    expect(partnerCashoutRefusal({ ...ok, amountCents: 5000 })).toBeNull();
    for (const amountCents of [0, 500, 2400, 3000, 7500, 10_000, -2500, 2500.5]) {
      expect(partnerCashoutRefusal({ ...ok, amountCents })).toBe("invalid_amount");
    }
  });
  it("refuses a locked partner even with the money there", () => {
    expect(partnerCashoutRefusal({ amountCents: 2500, unlocked: false, availableCents: 5000 })).toBe(
      "locked",
    );
  });
  it("refuses more than the available balance", () => {
    expect(partnerCashoutRefusal({ amountCents: 5000, unlocked: true, availableCents: 4500 })).toBe(
      "insufficient_balance",
    );
    expect(partnerCashoutRefusal({ amountCents: 2500, unlocked: true, availableCents: 2500 })).toBeNull();
  });
});

describe("code matching", () => {
  it("ignores case and spaces", () => {
    expect(normalizePartnerCode("ERIC C")).toBe("ERICC");
    expect(normalizePartnerCode("eric c")).toBe("ERICC");
    expect(normalizePartnerCode("  Eric   C ")).toBe("ERICC");
    expect(normalizePartnerCode("ericc")).toBe("ERICC");
  });
  it("rejects what can't be a code", () => {
    for (const raw of ["", "   ", null, undefined, 42, "ERIC!", "x".repeat(33)]) {
      expect(normalizePartnerCode(raw)).toBeNull();
    }
  });
});

describe("which plans qualify", () => {
  it("derives from the plan table: $8 of margin after Stripe's fee", () => {
    expect(PARTNER_PROGRAM.rewardCents).toBe(500);
    expect(PARTNER_PROGRAM.minPlanMarginCents).toBe(800);
    // 2000 - 58 - 30
    expect(planMarginCents(2000)).toBe(1912);
    expect(PARTNER_QUALIFYING_PLANS).toEqual(["starter", "pro", "pro_ai"]);
    expect(PARTNER_QUALIFYING_PLANS).not.toContain("free");
  });

  it("a paid month of a qualifying plan earns the reward", () => {
    expect(partnerInvoiceQualifies("starter", 2000)).toBe(true);
    expect(partnerInvoiceQualifies("pro_ai", Math.round(PLANS.pro_ai.priceMonthlyUsd * 100))).toBe(true);
  });

  it("no plan, the free plan, or an unknown plan never does", () => {
    expect(partnerInvoiceQualifies(null, 2000)).toBe(false);
    expect(partnerInvoiceQualifies("free", 2000)).toBe(false);
    expect(partnerInvoiceQualifies("enterprise", 99_999)).toBe(false);
  });

  it("a month discounted below the margin doesn't qualify", () => {
    expect(partnerInvoiceQualifies("starter", 0)).toBe(false);
    expect(partnerInvoiceQualifies("starter", 800)).toBe(false); // keeps 746
    expect(partnerInvoiceQualifies("starter", 856)).toBe(true); // keeps 801
  });
});
