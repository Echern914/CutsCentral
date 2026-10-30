import { describe, expect, it } from "vitest";
import {
  nativeCapabilities,
  OPEN_WEB_MESSAGE,
  parseOpenAuthRequest,
  parseOpenWebRequest,
  resumeUrl,
} from "./nativeBridge";

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

/**
 * "Manage plan on getchairback.com ↗": the page asks for billing in Safari.
 * The page sends a PATH; the app builds the address on its own origin and
 * honours listed paths only, so the message cannot become an open redirect.
 */
describe("parseOpenWebRequest", () => {
  const web = { webOrigin: "https://getchairback.com" };
  const ask = (m: unknown) => parseOpenWebRequest(JSON.stringify(m), web);

  it("opens billing - with or without the plan cards anchor - on OUR origin", () => {
    expect(ask({ type: OPEN_WEB_MESSAGE, path: "/dashboard/billing#plans" })).toBe(
      "https://getchairback.com/dashboard/billing#plans",
    );
    expect(ask({ type: OPEN_WEB_MESSAGE, path: "/dashboard/billing" })).toBe(
      "https://getchairback.com/dashboard/billing",
    );
  });

  it("🔴 refuses any other path, any URL, and anything that could become a host", () => {
    for (const path of [
      "https://evil.example/dashboard/billing",
      "//evil.example/dashboard/billing",
      "/dashboard/billing/../../login",
      "/dashboard/billing?x=1",
      "/dashboard",
      "/login",
      "/dashboard/payments",
      ".evil.example/dashboard/billing",
      "",
    ]) {
      expect(ask({ type: OPEN_WEB_MESSAGE, path })).toBeNull();
    }
  });

  it("ignores other messages, missing fields and non-JSON", () => {
    expect(ask({ type: "cb:open-auth", path: "/dashboard/billing" })).toBeNull();
    expect(ask({ type: OPEN_WEB_MESSAGE })).toBeNull();
    expect(ask({ type: OPEN_WEB_MESSAGE, path: 42 })).toBeNull();
    expect(parseOpenWebRequest("cb:ready", web)).toBeNull();
    expect(parseOpenWebRequest("null", web)).toBeNull();
  });

  it("is the message the web sends (apps/web lib/useNativeBillingLink.ts)", () => {
    expect(OPEN_WEB_MESSAGE).toBe("cb:open-web");
  });
});

describe("nativeCapabilities", () => {
  it("announces openWeb on iOS, where the US-storefront link-out applies", () => {
    expect(nativeCapabilities({ platform: "ios", nextUpWidget: false })).toEqual({
      openAuth: true,
      rewardsTab: true,
      openWeb: true,
    });
  });

  it("🔴 never on Android: the page there keeps showing no billing link", () => {
    expect(nativeCapabilities({ platform: "android", nextUpWidget: false }).openWeb).toBeUndefined();
  });

  it("keeps the widget flag tied to its build flag", () => {
    expect(nativeCapabilities({ platform: "ios", nextUpWidget: true }).nextUpWidget).toBe(true);
    expect(nativeCapabilities({ platform: "ios", nextUpWidget: false }).nextUpWidget).toBeUndefined();
  });
});
