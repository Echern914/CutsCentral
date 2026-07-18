import { describe, expect, it } from "vitest";
import { ACCENT_HEX_REGEX, BOOKING_MODES, SLUG_REGEX } from "./constants.js";

describe("SLUG_REGEX", () => {
  it("accepts real handles, including interior dashes", () => {
    for (const slug of ["a-b", "abc", "dricks-barbershop", "fade-factory-2", "x9z"]) {
      expect(SLUG_REGEX.test(slug), slug).toBe(true);
    }
  });

  it("rejects leading/trailing dashes, invalid chars, and short/long handles", () => {
    for (const slug of ["-ab", "ab-", "my_shop", "My-Shop", "ab", "", "a".repeat(41)]) {
      expect(SLUG_REGEX.test(slug), slug).toBe(false);
    }
  });
});

describe("ACCENT_HEX_REGEX", () => {
  it("accepts a full 6-digit hex only", () => {
    expect(ACCENT_HEX_REGEX.test("#D4AF37")).toBe(true);
    expect(ACCENT_HEX_REGEX.test("#d4af37")).toBe(true);
    for (const hex of ["#12", "#D4AF3", "#D4AF377", "D4AF37", "#GGGGGG"]) {
      expect(ACCENT_HEX_REGEX.test(hex), hex).toBe(false);
    }
  });
});

describe("BOOKING_MODES", () => {
  it("includes every mode the product supports (square once went missing from a hand-copied union)", () => {
    expect([...BOOKING_MODES].sort()).toEqual(["acuity", "link", "native", "square"]);
  });
});
