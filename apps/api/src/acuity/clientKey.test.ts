import { describe, expect, it } from "vitest";
import { deriveAcuityClientKey, toE164 } from "./clientKey.js";

describe("deriveAcuityClientKey", () => {
  it("prefers a valid phone, normalized to E.164", () => {
    expect(deriveAcuityClientKey({ phone: "(302) 555-0123", email: "a@b.com" })).toBe(
      "tel:+13025550123",
    );
  });

  it("falls back to lowercased email when phone is missing/invalid", () => {
    expect(deriveAcuityClientKey({ phone: "abc", email: "Foo@Bar.com" })).toBe(
      "mail:foo@bar.com",
    );
    expect(deriveAcuityClientKey({ email: "X@Y.com" })).toBe("mail:x@y.com");
  });

  it("namespaces so phone and email keys never collide", () => {
    const tel = deriveAcuityClientKey({ phone: "302-555-0123" });
    const mail = deriveAcuityClientKey({ email: "302@555.com" });
    expect(tel.startsWith("tel:")).toBe(true);
    expect(mail.startsWith("mail:")).toBe(true);
    expect(tel).not.toBe(mail);
  });

  it("falls back to an anon name slug when no contact info", () => {
    expect(deriveAcuityClientKey({ firstName: "John", lastName: "Doe" })).toBe(
      "anon:john-doe",
    );
    expect(deriveAcuityClientKey({})).toBe("anon:unknown");
  });
});

describe("toE164", () => {
  it("normalizes US numbers", () => {
    expect(toE164("302-555-0123")).toBe("+13025550123");
  });
  it("returns null for invalid/absent", () => {
    expect(toE164("xyz")).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(toE164(undefined)).toBeNull();
  });
});
