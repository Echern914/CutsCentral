import { describe, expect, it } from "vitest";
import { safeCampaignParams, signupTargetPath } from "./affiliateJoin";

/**
 * The /join query string is attacker-controlled: it is whatever was in the
 * link someone clicked. These pin that only known-safe marketing keys survive
 * and that the destination is always our own signup path.
 */
describe("safeCampaignParams", () => {
  it("keeps allowlisted marketing keys and drops everything else", () => {
    const input = new URLSearchParams({
      utm_source: "instagram",
      utm_campaign: "spring",
      ref: "SOMECODE",
      next: "https://evil.test/steal",
      redirect_uri: "https://evil.test",
      admin: "true",
    });
    const out = safeCampaignParams(input);
    expect(out.get("utm_source")).toBe("instagram");
    expect(out.get("utm_campaign")).toBe("spring");
    expect(out.get("ref")).toBeNull();
    expect(out.get("next")).toBeNull();
    expect(out.get("redirect_uri")).toBeNull();
    expect(out.get("admin")).toBeNull();
  });

  it("drops empty and over-long values instead of truncating them", () => {
    const input = new URLSearchParams({
      utm_source: "   ",
      utm_medium: "x".repeat(201),
      utm_term: "  keep-me  ",
    });
    const out = safeCampaignParams(input);
    expect(out.get("utm_source")).toBeNull();
    expect(out.get("utm_medium")).toBeNull();
    expect(out.get("utm_term")).toBe("keep-me");
  });
});

describe("signupTargetPath", () => {
  it("always returns our own root-relative signup path", () => {
    expect(signupTargetPath(new URLSearchParams())).toBe("/signup");
    expect(
      signupTargetPath(new URLSearchParams({ next: "https://evil.test" })),
    ).toBe("/signup");
  });

  it("carries safe campaign params through", () => {
    const path = signupTargetPath(
      new URLSearchParams({ utm_source: "tiktok", ref: "CODE" }),
    );
    expect(path).toBe("/signup?utm_source=tiktok");
    expect(path.startsWith("/")).toBe(true);
    expect(path).not.toContain("CODE");
  });

  it("cannot be steered to another origin", () => {
    for (const hostile of [
      "//evil.test",
      "https://evil.test",
      "/\\evil.test",
      "javascript:alert(1)",
    ]) {
      const path = signupTargetPath(new URLSearchParams({ next: hostile, url: hostile }));
      expect(path).toBe("/signup");
    }
  });
});
