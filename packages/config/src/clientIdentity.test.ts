import { describe, expect, it } from "vitest";
import {
  checkTellApart,
  isMeaningfulLastName,
  lastNameHasLetter,
  instagramUrl,
  normalizeInstagramHandle,
  tellApartRefusal,
  TELL_APART_MESSAGE,
} from "./clientIdentity.js";

const handle = (raw: string | null | undefined) => {
  const r = normalizeInstagramHandle(raw);
  return r.ok ? r.handle : "INVALID";
};

describe("normalizeInstagramHandle: forgiving about shape", () => {
  it.each([
    ["mike.fades", "mike.fades"],
    ["@mike.fades", "mike.fades"],
    ["@@mike.fades", "mike.fades"],
    ["  @Mike.Fades  ", "mike.fades"],
    ["MIKE_FADES", "mike_fades"],
    ["instagram.com/mike.fades", "mike.fades"],
    ["https://instagram.com/mike.fades", "mike.fades"],
    ["https://www.instagram.com/Mike.Fades/", "mike.fades"],
    ["http://instagram.com/mike.fades?igsh=abc123&utm_source=qr", "mike.fades"],
    ["https://www.instagram.com/mike.fades/?hl=en", "mike.fades"],
    ["https://m.instagram.com/mike.fades#top", "mike.fades"],
    ["instagr.am/mike.fades", "mike.fades"],
    ["WWW.INSTAGRAM.COM/@Mike.Fades", "mike.fades"],
    // Profile links that put the username SECOND.
    ["https://www.instagram.com/stories/mike.fades/3312?igsh=x", "mike.fades"],
    ["instagram.com/_u/mike.fades", "mike.fades"],
    ["a".repeat(30), "a".repeat(30)],
  ])("%j -> %j", (raw, want) => {
    expect(handle(raw)).toBe(want);
  });

  it("blank is no handle, not an error", () => {
    expect(handle("")).toBeNull();
    expect(handle("   ")).toBeNull();
    expect(handle(null)).toBeNull();
    expect(handle(undefined)).toBeNull();
  });
});

describe("normalizeInstagramHandle: exact about the result", () => {
  it.each([
    ["mike fades"],
    ["mike-fades"],
    ["mike!"],
    ["mike/fades"],
    ["<script>"],
    ["mike'); DROP TABLE"],
    ["émile"],
    ["mike​fades"],
    ["a".repeat(31)],
    ["x".repeat(500)],
    ["@"],
    ["...."],
    ["https://instagram.com/"],
    ["https://evil.example.com/mike"],
    ["instagram.com.evil.example/mike"],
    // What the share sheet copies from a post, reel or video: the first path
    // segment is Instagram's own route, not a person. Stored, it would read
    // "@p" or "@reel" and satisfy the rule while identifying nobody.
    ["https://www.instagram.com/p/C8xYz12AbCd/"],
    ["https://www.instagram.com/reel/C8xYz/?igsh=abc"],
    ["instagram.com/reels/C8xYz"],
    ["instagram.com/tv/C8xYz"],
    ["instagram.com/explore/tags/fades"],
    ["instagram.com/accounts/login"],
    ["instagram.com/stories/"],
  ])("%j is refused", (raw) => {
    expect(handle(raw)).toBe("INVALID");
  });
});

describe("checkTellApart: a last name OR an Instagram handle", () => {
  it("refuses a first-name-only signup", () => {
    const r = checkTellApart({});
    expect(r).toMatchObject({ ok: false, code: "NAME_OR_INSTAGRAM_REQUIRED", message: TELL_APART_MESSAGE });
    expect(checkTellApart({ lastName: "   ", instagram: "  " }).ok).toBe(false);
    expect(checkTellApart({ lastName: null, instagram: null }).ok).toBe(false);
  });

  // 🔴 Drick's own screenshot: "Isaiah C". A lone initial, or punctuation
  // typed to get past the field, is not a last name the shop can tell people
  // apart by. Two letters is the bar - or one letter from a script where a
  // single character IS a whole surname (李, 김) - so no real surname is
  // refused, and a customer with a genuinely one-letter romanized surname
  // still has the Instagram way in on every surface that runs this rule.
  it.each([["C"], ["C."], ["."], ["-"], ["  -  "], ["?"], ["x"], ["1"], ["12"]])(
    "%j alone is not a last name",
    (lastName) => {
      expect(checkTellApart({ lastName })).toMatchObject({ ok: false, code: "NAME_OR_INSTAGRAM_REQUIRED" });
    },
  );

  it.each([["Ng"], ["Li"], ["O'Neil"], ["Smith-Jones"], ["de la Cruz"], ["Núñez"], ["李"], ["김"]])(
    "%j is a last name",
    (lastName) => {
      expect(checkTellApart({ lastName })).toMatchObject({ ok: true, lastName: lastName.trim() });
    },
  );

  it("an initial WITH a handle is fine - the handle tells them apart", () => {
    expect(checkTellApart({ lastName: "C", instagram: "isaiah.c" })).toEqual({
      ok: true,
      lastName: "C",
      instagram: "isaiah.c",
    });
    // Punctuation is never stored as a surname.
    expect(checkTellApart({ lastName: ".", instagram: "isaiah.c" })).toEqual({
      ok: true,
      lastName: null,
      instagram: "isaiah.c",
    });
  });

  it("accepts a last name alone", () => {
    expect(checkTellApart({ lastName: " Jones " })).toEqual({ ok: true, lastName: "Jones", instagram: null });
  });

  it("accepts an Instagram handle alone, normalized", () => {
    expect(checkTellApart({ instagram: "@Mike.Fades" })).toEqual({
      ok: true,
      lastName: null,
      instagram: "mike.fades",
    });
  });

  it("refuses a handle that cannot be one, even alongside a last name", () => {
    // Dropping it silently would lose what the customer meant to give.
    expect(checkTellApart({ lastName: "Jones", instagram: "mike fades" })).toMatchObject({
      ok: false,
      code: "INVALID_INSTAGRAM",
    });
  });

  it("the API refusal carries a stable lowercase error, the code and the sentence", () => {
    expect(tellApartRefusal("NAME_OR_INSTAGRAM_REQUIRED")).toEqual({
      error: "name_or_instagram_required",
      code: "NAME_OR_INSTAGRAM_REQUIRED",
      field: "lastName",
      message: TELL_APART_MESSAGE,
    });
    expect(tellApartRefusal("INVALID_INSTAGRAM")).toMatchObject({ error: "invalid_instagram", field: "instagram" });
  });
});

describe("instagramUrl", () => {
  it("links the bare handle", () => {
    expect(instagramUrl("mike.fades")).toBe("https://instagram.com/mike.fades");
  });
});

describe("last-name predicates", () => {
  it("isMeaningfulLastName: two letters, or one caseless-script letter", () => {
    expect(isMeaningfulLastName("Ng")).toBe(true);
    expect(isMeaningfulLastName("李")).toBe(true);
    expect(isMeaningfulLastName("C")).toBe(false);
    expect(isMeaningfulLastName("C.")).toBe(false);
    expect(isMeaningfulLastName(null)).toBe(false);
  });

  it("lastNameHasLetter: the booking page's floor - punctuation is not a name", () => {
    expect(lastNameHasLetter("C")).toBe(true);
    expect(lastNameHasLetter(" O'Neil ")).toBe(true);
    expect(lastNameHasLetter(".")).toBe(false);
    expect(lastNameHasLetter("-")).toBe(false);
    expect(lastNameHasLetter("")).toBe(false);
  });
});
