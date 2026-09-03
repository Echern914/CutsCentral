import { describe, expect, it } from "vitest";
// The config is self-contained (no imports of its own), so this loads the REAL
// module and asks it for the REAL headers - not a string match on the source.
import nextConfig from "../../next.config.mjs";

/**
 * 🔴 THE CSP IS PART OF THE PAYMENT INTEGRATION, AND IT FAILS SILENTLY.
 *
 * A missing host here does not throw, does not 500 and does not show up in any
 * other test. The browser blocks the frame, Stripe omits the payment method,
 * and the checkout carries on looking completely normal — one payment option
 * poorer for every customer. `https://*.js.stripe.com` was missing for exactly
 * that reason: Stripe.js starts wallet frames on separate origins where it can,
 * so Apple Pay and Link were the two things it could quietly cost us.
 */

interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

const rules = (await (
  nextConfig as unknown as { headers: () => Promise<HeaderRule[]> }
).headers()) as HeaderRule[];

/** The catch-all rule is the one every page (including /book) actually gets. */
const catchAll = rules.find((r) => r.source === "/(.*)");
const csp = catchAll?.headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "";

/** One directive out of the joined policy, as a list of sources. */
function directive(name: string): string[] {
  const found = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
  return found ? found.slice(name.length).trim().split(/\s+/).filter(Boolean) : [];
}

describe("the Content-Security-Policy served to every page", () => {
  it("exists at all, on the catch-all rule", () => {
    expect(catchAll, "no catch-all header rule").toBeDefined();
    expect(csp.length).toBeGreaterThan(50);
  });

  it("🔴 allows Stripe.js from BOTH js.stripe.com and its wildcard origins", () => {
    // Stripe's own CSP guidance lists both spellings, and the wildcard is what
    // wallet frames reach for. Only the bare host shipped.
    for (const d of ["script-src", "frame-src"]) {
      expect(directive(d), d).toContain("https://js.stripe.com");
      expect(directive(d), d).toContain("https://*.js.stripe.com");
    }
  });

  it("allows the redirect host, so a 3-D Secure challenge can render", () => {
    expect(directive("frame-src")).toContain("https://hooks.stripe.com");
  });

  it("allows Stripe's API for the confirm call", () => {
    expect(directive("connect-src")).toContain("https://api.stripe.com");
  });

  it("allows Link, which the Payment Element offers alongside the wallets", () => {
    expect(directive("frame-src")).toContain("https://link.com");
    expect(directive("frame-src")).toContain("https://*.link.com");
    expect(directive("connect-src")).toContain("https://*.link.com");
  });

  it("still keeps the app itself locked down", () => {
    // Guard against a well-meaning "just loosen the CSP" edit taking the rest
    // of the policy with it.
    expect(directive("default-src")).toEqual(["'self'"]);
    expect(directive("frame-ancestors")).toEqual(["'none'"]);
    expect(directive("base-uri")).toEqual(["'self'"]);
    expect(directive("form-action")).toEqual(["'self'"]);
    expect(directive("object-src").length === 0 || directive("object-src")[0] === "'none'").toBe(
      true,
    );
  });

  it("keeps the other security headers on the same rule", () => {
    const keys = catchAll?.headers.map((h) => h.key) ?? [];
    for (const key of [
      "X-Frame-Options",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Strict-Transport-Security",
      "Permissions-Policy",
    ]) {
      expect(keys, key).toContain(key);
    }
  });
});
