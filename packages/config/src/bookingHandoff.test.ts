import { describe, expect, it } from "vitest";
import { bookingHandoffFrom, bookingHandoffQuery } from "./bookingHandoff";

const H = "eyJwdXJwb3NlIjoiY3VzdG9tZXJfYm9va2luZ192MSJ9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWc";

describe("the booking handoff on a web page", () => {
  it("keeps one well-formed value", () => {
    expect(bookingHandoffFrom(H)).toBe(H);
    expect(bookingHandoffQuery(bookingHandoffFrom(H))).toBe(`?cb_me=${H}`);
  });

  it("drops anything else - the visit is then an ordinary one", () => {
    for (const v of [undefined, null, "", "x.y", `${H}&evil=1`, `${H}.extra`, "a".repeat(900) + ".b", [H, H], [H]]) {
      expect(bookingHandoffFrom(v as string | string[] | undefined)).toBeNull();
    }
    expect(bookingHandoffQuery(null)).toBe("");
  });
});
