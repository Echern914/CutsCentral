import { describe, expect, it } from "vitest";
import {
  checkTellApart,
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
