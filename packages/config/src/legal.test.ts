import { describe, expect, it } from "vitest";
import { TERMS_VERSION, termsAcceptanceRequired } from "./legal.js";
import { WHATS_NEW } from "./whatsNew.js";

/**
 * Who is asked to agree to the Terms + Privacy before the dashboard opens.
 * Exactly the people without the CURRENT version on record.
 */
describe("termsAcceptanceRequired", () => {
  it("never agreed: asked", () => {
    expect(termsAcceptanceRequired(null)).toBe(true);
    expect(termsAcceptanceRequired(undefined)).toBe(true);
    expect(termsAcceptanceRequired("")).toBe(true);
  });

  it("🔴 agreed to an older version: asked again", () => {
    expect(termsAcceptanceRequired("2026-06-12")).toBe(true);
  });

  it("agreed to a version this build does not serve (rolled back): asked again", () => {
    expect(termsAcceptanceRequired("2099-01-01")).toBe(true);
  });

  it("agreed to the current version: not asked", () => {
    expect(termsAcceptanceRequired(TERMS_VERSION)).toBe(false);
  });

  it("the version is a YYYY-MM-DD date key", () => {
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("the re-agreement was announced in What's New", () => {
    expect(WHATS_NEW.some((e) => e.id === `${TERMS_VERSION}-terms-agreement`)).toBe(true);
  });
});
