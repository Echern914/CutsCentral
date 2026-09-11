import { describe, expect, it } from "vitest";
import { normalizeShopHandle, shopHandleKey, shopSlugFromName } from "./shopHandle.js";

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

  it("🔴 takes the shop's own NAME, which is the thing a customer actually knows", () => {
    // The defect this closes. Shop creation turns "United Barbershop" into
    // `united-barbershop`; this used to reject a space outright, so the one
    // string guaranteed to be right was the one string that could never
    // resolve. Checked against production: every live shop 404'd by name.
    for (const typed of [
      "United Barbershop",
      "united barbershop",
      "UNITED BARBERSHOP",
      "  United   Barbershop  ",
      "United_Barbershop",
      "United - Barbershop",
    ]) {
      expect(normalizeShopHandle(typed), typed).toBe("united-barbershop");
    }
  });

  it("folds accents rather than eating the letter under them", () => {
    // Collapsing "é" as punctuation would give `irza-beaut`, losing a letter
    // and the shop with it.
    expect(normalizeShopHandle("Irza Beauté")).toBe("irza-beaute");
    expect(shopSlugFromName("Señor Fades")).toBe("senor-fades");
  });

  it("mints and reads with ONE transform, so a name always finds its own shop", () => {
    // The two used to be separate implementations; that is how they drifted.
    for (const name of [
      "United Barbershop",
      "JUP Design Studio",
      "Deltrimz studio",
      "FadesByMikey Barbershop",
      "Irza beaute",
    ]) {
      expect(normalizeShopHandle(name), name).toBe(shopSlugFromName(name));
    }
  });
});

describe("shopHandleKey — where the spaces fall is not knowledge", () => {
  it("collapses every spelling of the same letters to one key", () => {
    // "FadesByMikey Barbershop" mints `fadesbymikey-barbershop`: one word then
    // two, with the dash where nobody would guess it.
    const key = shopHandleKey("fadesbymikey-barbershop");
    expect(key).toBe("fadesbymikeybarbershop");
    for (const typed of [
      "FadesByMikey Barbershop",
      "fades by mikey barbershop",
      "fadesbymikeybarbershop",
      "Fades-By-Mikey-Barbershop",
    ]) {
      expect(shopHandleKey(normalizeShopHandle(typed)!), typed).toBe(key);
    }
  });

  it("🔴 is still every letter, in order - it is not a fuzzy key", () => {
    const key = shopHandleKey("united-barbershop");
    // A prefix, a typo and a missing letter all key differently, so the loose
    // lookup can no more discover a shop than the exact one can.
    expect(shopHandleKey("united")).not.toBe(key);
    expect(shopHandleKey("untied-barbershop")).not.toBe(key);
    expect(shopHandleKey("united-barbersho")).not.toBe(key);
    expect(shopHandleKey("barbershop")).not.toBe(key);
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
      "-", // nothing but a separator
      "!!!",
      "🙂",
      "a".repeat(60), // too long
      "%",
    ]) {
      expect(normalizeShopHandle(junk), JSON.stringify(junk)).toBeNull();
    }
  });

  it("🔴 spacing and punctuation are SHAPE, not knowledge - they resolve", () => {
    // These used to be refused outright, which is what made a shop unfindable
    // by its own name. They are the same letters in different clothes, and
    // every one of them still requires knowing all of them.
    expect(normalizeShopHandle("has spaces")).toBe("has-spaces");
    expect(normalizeShopHandle("UPPER CASE WORDS")).toBe("upper-case-words");
    expect(normalizeShopHandle("under_score")).toBe("under-score");
    expect(normalizeShopHandle("-leading-hyphen")).toBe("leading-hyphen");
    expect(normalizeShopHandle("trailing-hyphen-")).toBe("trailing-hyphen");
  });

  it("is idempotent — normalizing twice changes nothing", () => {
    const once = normalizeShopHandle("https://getchairback.com/s/DrickCuttinUp")!;
    expect(normalizeShopHandle(once)).toBe(once);
  });
});
