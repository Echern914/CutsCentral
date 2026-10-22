import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, newTotpSecret, otpauthUri, totpCode, totpStep, verifyTotp } from "./totp.js";

/**
 * The authenticator math, held to the standard's own test vectors - a code
 * that disagrees with Google Authenticator by one digit locks the admin out.
 */

// RFC 6238 Appendix B: the SHA-1 seed "12345678901234567890", in base32.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("RFC 6238 test vectors (SHA-1, 8 digits)", () => {
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [seconds, code] of vectors) {
    it(`T=${seconds} -> ${code}`, () => {
      expect(totpCode(RFC_SECRET, totpStep(new Date(seconds * 1000)), 8)).toBe(code);
    });
  }

  it("the seed round-trips through base32", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(RFC_SECRET).toString("ascii")).toBe("12345678901234567890");
  });
});

describe("checking a typed code", () => {
  const at = new Date(1_800_000_000_000);
  const step = totpStep(at);
  const code = totpCode(RFC_SECRET, step);

  it("accepts the current code, and says which step it was", () => {
    expect(verifyTotp(RFC_SECRET, code, at, null)).toEqual({ ok: true, step });
  });

  it("allows a phone clock a step either side", () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), at, null)).toEqual({ ok: true, step: step - 1 });
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), at, null)).toEqual({ ok: true, step: step + 1 });
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), at, null)).toEqual({ ok: false });
  });

  it("🔴 a code that worked once never works again (replay)", () => {
    expect(verifyTotp(RFC_SECRET, code, at, step)).toEqual({ ok: false });
    // ...nor any older one.
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), at, step)).toEqual({ ok: false });
  });

  it("refuses anything that is not six digits", () => {
    expect(verifyTotp(RFC_SECRET, "12345", at, null)).toEqual({ ok: false });
    expect(verifyTotp(RFC_SECRET, "12345a", at, null)).toEqual({ ok: false });
  });
});

describe("setup", () => {
  it("a new secret is 160 random bits, different every time", () => {
    const a = newTotpSecret();
    expect(base32Decode(a)).toHaveLength(20);
    expect(newTotpSecret()).not.toBe(a);
  });

  it("the QR link carries what authenticator apps expect", () => {
    const uri = otpauthUri({ secret: "ABC", account: "eric@example.com", issuer: "ChairBack admin" });
    expect(uri).toMatch(/^otpauth:\/\/totp\/ChairBack%20admin%3Aeric%40example\.com\?/);
    const params = new URL(uri.replace("otpauth://", "https://x/")).searchParams;
    expect(Object.fromEntries(params)).toMatchObject({ secret: "ABC", issuer: "ChairBack admin", digits: "6", period: "30" });
  });
});
