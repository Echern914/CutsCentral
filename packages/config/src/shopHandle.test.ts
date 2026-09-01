import { describe, expect, it } from "vitest";
import { normalizeShopHandle } from "./shopHandle.js";

describe("normalizeShopHandle — forgiving about input", () => {
  it("takes the handle as typed", () => {
    expect(normalizeShopHandle("drickcuttinup")).toBe("drickcuttinup");
  });

  it("forgives capitals, spaces and a leading @", () => {
    // All three are what a phone keyboard or an Instagram habit produces.
    expect(normalizeShopHandle("  Drickcuttinup ")).toBe("drickcuttinup");
    expect(normalizeShopHandle("@drickcuttinup")).toBe("drickcuttinup");
    expect(normalizeShopHandle("@@DrickCuttinUp")).toBe("drickcuttinup");
  });

  it("accepts the link the shop texted them, in every shape it arrives", () => {
    // "or get a link" - the link IS the handle most customers actually hold.
    for (const link of [
      "https://getchairback.com/s/drickcuttinup",
      "https://getchairback.com/book/drickcuttinup",
      "getchairback.com/s/drickcuttinup",
      "https://getchairback.com/s/drickcuttinup?from=text",
      "https://getchairback.com/s/drickcuttinup#hours",
      "https://getchairback.com/s/drickcuttinup/",
    ]) {
      expect(normalizeShopHandle(link), link).toBe("drickcuttinup");
    }
  });
});

describe("normalizeShopHandle — 🔴 exact about matching", () => {
  it("a PREFIX is not the handle, and must never become it", () => {
    // The whole point of the feature: you find the shop you were told about,
    // not every shop that starts like it. "drick" is a different string, so
    // it resolves to a different (probably nonexistent) shop - never to
    // drickcuttinup.
    expect(normalizeShopHandle("drick")).toBe("drick");
    expect(normalizeShopHandle("drick")).not.toBe("drickcuttinup");
  });

  it("does not repair a near miss into a real handle", () => {
    // No fuzzy, no "did you mean". A typo finds nothing, which is correct:
    // repairing it would turn the finder into a way to discover shops.
    expect(normalizeShopHandle("drickcuttinup1")).toBe("drickcuttinup1");
    expect(normalizeShopHandle("drickcutinup")).toBe("drickcutinup");
  });

  it("refuses anything that could not be a handle at all", () => {
    // Never reaches the database. A caller that does not query cannot be
    // timed to tell "no such shop" from "not a handle".
    for (const junk of [
      "",
      "   ",
      "@",
      "a", // too short for SLUG_REGEX
      "-leading-hyphen",
      "trailing-hyphen-",
      "has spaces",
      "UPPER CASE WORDS",
      "emoji🙂handle",
      "under_score",
      "a".repeat(60), // too long
      "https://getchairback.com/",
      "%",
    ]) {
      expect(normalizeShopHandle(junk), JSON.stringify(junk)).toBeNull();
    }
  });

  it("is idempotent — normalizing twice changes nothing", () => {
    const once = normalizeShopHandle("https://getchairback.com/s/DrickCuttinUp")!;
    expect(normalizeShopHandle(once)).toBe(once);
  });
});
