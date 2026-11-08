import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { affiliateShortCodePrefix, normalizeAffiliateCode, shortAffiliateCodeKey } from "./affiliateAttribution.js";
import { HEARD_ABOUT_IDS, heardAboutLabel, isHeardAboutId } from "./heardAbout.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("how did you hear about us", () => {
  it("🔴 every answer is one the database's CHECK allows", () => {
    const sql = readFileSync(
      join(
        here,
        "../../db/prisma/migrations/20261089000000_affiliate_short_code_heard_about/migration.sql",
      ),
      "utf8",
    );
    const pinned = /"heardAbout" IN \(([^)]*)\)/.exec(sql)?.[1] ?? "";
    expect([...pinned.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...HEARD_ABOUT_IDS]);
  });

  it("the first answer speaks the person's own trade", () => {
    expect(heardAboutLabel("another_barber", "nail tech")).toBe("Another nail tech");
    expect(heardAboutLabel("another_barber")).toBe("Another pro");
    expect(heardAboutLabel("friend_family")).toBe("Friend or family");
  });

  it("only a listed answer counts", () => {
    expect(isHeardAboutId("tiktok")).toBe(true);
    expect(isHeardAboutId("billboard")).toBe(false);
    expect(isHeardAboutId(null)).toBe(false);
  });
});

describe("the affiliate short code's shape", () => {
  it("takes up to five letters of the name, or SHOP when there are too few", () => {
    expect(affiliateShortCodePrefix("Snow's Fades")).toBe("SNOWS");
    expect(affiliateShortCodePrefix("Ace")).toBe("ACE");
    expect(affiliateShortCodePrefix("A1")).toBe("SHOP");
    expect(affiliateShortCodePrefix("理髪店")).toBe("SHOP");
  });

  it("🔴 the shortest one minted still passes the referral link's own check", () => {
    expect(normalizeAffiliateCode(`${affiliateShortCodePrefix("Ace")}100`)).toBe("ACE100");
  });

  it("ignores spaces and case, the way people say a code", () => {
    expect(shortAffiliateCodeKey(" snow 482 ")).toBe("SNOW482");
  });
});
