import { describe, expect, it } from "vitest";
import { parseOpenAuthRequest, resumeUrl } from "./nativeBridge";

const origins = { apiOrigin: "https://api.getchairback.com" };
const good = {
  type: "cb:open-auth",
  url: "https://connect.stripe.com/oauth/v2/authorize?client_id=ca_x",
  returnUrl: "chairback://stripe/connected",
  resumePath: "/dashboard/payments",
};

/**
 * A page message can open a system authentication sheet, so what it may ask
 * for is tightly bounded: Stripe's authorize page or our own API, a return
 * on our custom scheme, and a resume path on our own origin. Everything else
 * is dropped.
 */
describe("parseOpenAuthRequest", () => {
  it("accepts a Stripe authorize URL with our return scheme and a bare path", () => {
    expect(parseOpenAuthRequest(JSON.stringify(good), origins)).toEqual({
      url: good.url,
      returnUrl: good.returnUrl,
      resumePath: good.resumePath,
    });
  });

  it("accepts our own API as a start", () => {
    const r = parseOpenAuthRequest(
      JSON.stringify({ ...good, url: `${origins.apiOrigin}/api/payments/connect/oauth/start` }),
      origins,
    );
    expect(r?.url).toContain(origins.apiOrigin);
  });

  it("🔴 refuses any other host, including lookalikes", () => {
    for (const url of [
      "https://evil.example/phish",
      "https://connect.stripe.com.evil.tld/x",
      "https://api.getchairback.com.evil.tld/x",
      "http://connect.stripe.com/insecure",
      "javascript:alert(1)",
    ]) {
      expect(parseOpenAuthRequest(JSON.stringify({ ...good, url }), origins)).toBeNull();
    }
  });

  it("🔴 refuses a return URL that is not our scheme", () => {
    expect(
      parseOpenAuthRequest(JSON.stringify({ ...good, returnUrl: "https://evil.example/" }), origins),
    ).toBeNull();
  });

  it("🔴 refuses a resume path that could leave our origin", () => {
    for (const resumePath of ["https://evil.example", "//evil.example/x", "dashboard", ""]) {
      expect(parseOpenAuthRequest(JSON.stringify({ ...good, resumePath }), origins)).toBeNull();
    }
  });

  it("ignores other messages and non-JSON quietly", () => {
    expect(parseOpenAuthRequest("cb:ready", origins)).toBeNull();
    expect(parseOpenAuthRequest(JSON.stringify({ type: "cb:auth", bearer: "x" }), origins)).toBeNull();
    expect(parseOpenAuthRequest("{not json", origins)).toBeNull();
  });
});

describe("resumeUrl", () => {
  it("carries the callback's outcome onto the resume page", () => {
    expect(
      resumeUrl("https://getchairback.com", "/dashboard/payments", "chairback://stripe/connected?connect=linked"),
    ).toBe("https://getchairback.com/dashboard/payments?connect=linked");
  });

  it("a dismissed sheet reads as cancelled", () => {
    expect(resumeUrl("https://getchairback.com", "/dashboard/payments", null)).toBe(
      "https://getchairback.com/dashboard/payments?connect=cancelled",
    );
  });

  it("never passes an unexpected outcome value through", () => {
    expect(
      resumeUrl("https://getchairback.com", "/dashboard/payments", "chairback://x?connect=<script>"),
    ).toBe("https://getchairback.com/dashboard/payments?connect=cancelled");
  });
});
