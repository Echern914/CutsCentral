import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, decryptWithAny, encrypt, randomToken } from "./crypto.js";

const KEY = randomBytes(32).toString("base64");

describe("encrypt/decrypt (AES-256-GCM)", () => {
  it("round-trips a secret", () => {
    const secret = "acuity-access-token-abc123";
    const ct = encrypt(secret, KEY);
    expect(decrypt(ct, KEY)).toBe(secret);
  });

  it("produces different ciphertext each time (random IV)", () => {
    const a = encrypt("same", KEY);
    const b = encrypt("same", KEY);
    expect(a).not.toBe(b);
    expect(decrypt(a, KEY)).toBe("same");
    expect(decrypt(b, KEY)).toBe("same");
  });

  it("rejects a wrong key", () => {
    const ct = encrypt("secret", KEY);
    const otherKey = randomBytes(32).toString("base64");
    expect(() => decrypt(ct, otherKey)).toThrow();
  });

  it("rejects tampered ciphertext (auth tag)", () => {
    const ct = encrypt("secret", KEY);
    const parts = ct.split(":");
    // flip a byte in the ciphertext segment
    const tampered = `${parts[0]}:${parts[1]}:${Buffer.from("zzzz").toString("base64")}`;
    expect(() => decrypt(tampered, KEY)).toThrow();
  });

  it("rejects a malformed payload", () => {
    expect(() => decrypt("not-a-valid-payload", KEY)).toThrow();
  });

  it("rejects a key of wrong length", () => {
    const shortKey = randomBytes(16).toString("base64");
    expect(() => encrypt("x", shortKey)).toThrow(/32 bytes/);
  });
});

describe("decryptWithAny (key rotation)", () => {
  const NEW = randomBytes(32).toString("base64");
  const OLD = randomBytes(32).toString("base64");

  it("opens with the first key that fits, and says which", () => {
    expect(decryptWithAny(encrypt("t", NEW), [NEW, OLD])).toEqual({ plaintext: "t", keyIndex: 0 });
    expect(decryptWithAny(encrypt("t", OLD), [NEW, OLD])).toEqual({ plaintext: "t", keyIndex: 1 });
  });

  it("throws when no key opens it - never returns garbage", () => {
    const stranger = randomBytes(32).toString("base64");
    expect(() => decryptWithAny(encrypt("t", stranger), [NEW, OLD])).toThrow();
    expect(() => decryptWithAny("not-a-valid-payload", [NEW, OLD])).toThrow(/Malformed/);
  });

  it("throws with no keys at all", () => {
    expect(() => decryptWithAny(encrypt("t", NEW), [])).toThrow();
  });
});

describe("randomToken", () => {
  it("produces url-safe tokens of expected length and uniqueness", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
