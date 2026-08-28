import { describe, expect, it } from "vitest";
import { codeShapeOk, digestsMatch, hashOtp, mintCode } from "./otpPolicy.js";

/** The shared policy's pure properties - what both stores inherit. */
describe("otpPolicy", () => {
  it("🔴 the purpose separates digests for the SAME scope, phone and code", () => {
    const a = hashOtp("scope", "+12125550001", "walk_in_check_in", "123456");
    const b = hashOtp("scope", "+12125550001", "rewards_recovery", "123456");
    expect(a).not.toBe(b);
  });

  it("🔴 reproduces the kiosk digest byte-for-byte (rows at rest depend on this)", () => {
    // The exact legacy construction: `${shopId}:${phone}:walk_in_check_in:${code}`.
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const legacy = createHash("sha256")
      .update("shop_1:+12125550001:walk_in_check_in:654321", "utf8")
      .digest("hex");
    expect(hashOtp("shop_1", "+12125550001", "walk_in_check_in", "654321")).toBe(legacy);
  });

  it("mints uniform six digits and accepts only that shape", () => {
    for (let i = 0; i < 50; i++) expect(codeShapeOk(mintCode())).toBe(true);
    expect(codeShapeOk("12345")).toBe(false);
    expect(codeShapeOk("1234567")).toBe(false);
    expect(codeShapeOk("12345a")).toBe(false);
  });

  it("digestsMatch refuses length mismatches without throwing", () => {
    expect(digestsMatch("abcd", "abcdef")).toBe(false);
    expect(digestsMatch("abcd", "abcd")).toBe(true);
  });
});
