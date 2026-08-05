import { describe, expect, it } from "vitest";
import type { ApiEnv } from "@chairback/config";
import {
  buildPreflight,
  countMessagingServices,
  type PreflightCapabilities,
} from "./preflight.js";

/**
 * The point of these tests is the DEFAULT-DARK trap: every integration here is
 * behind an optional env seam, so "not configured" looks identical to "working"
 * at runtime. If the report ever starts calling an unconfigured deployment
 * ready, a real shop gets handed a product that silently sends nothing.
 */

/** A fully-configured deployment - the shape a launch-ready prod box has. */
function readyEnv(overrides: Partial<ApiEnv> = {}): ApiEnv {
  return {
    DRY_RUN: false,
    ENABLE_SCHEDULER: true,
    DB_RLS_ENFORCE: true,
    TWILIO_MESSAGING_SERVICE_SID: "MG1,MG2",
    TWILIO_CAMPAIGN_NUMBER_CAP: 49,
    RECEPTIONIST_MODEL: "claude-sonnet-5",
    STRIPE_PREMIUM_AI_PRICE_ID: "price_ai",
    STRIPE_RECEPTIONIST_PRICE_ID: "price_addon",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    SUPABASE_STORAGE_BUCKET: "shop-media",
    SQUARE_ENV: "production",
    SENTRY_DSN: "https://sentry.example.com/1",
    ...overrides,
  } as ApiEnv;
}

const readyCaps: PreflightCapabilities = {
  billing: true,
  connect: true,
  email: true,
  push: true,
  wallet: true,
  square: true,
  receptionist: true,
};

const find = (r: ReturnType<typeof buildPreflight>, key: string) => {
  const check = r.checks.find((c) => c.key === key);
  if (!check) throw new Error(`no check named ${key}`);
  return check;
};

describe("launch preflight", () => {
  it("a fully configured deployment reports zero blockers and zero warnings", () => {
    const report = buildPreflight(readyEnv(), readyCaps, true);
    expect(report.blockers).toBe(0);
    expect(report.warnings).toBe(0);
    expect(report.dryRun).toBe(false);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  it("an empty deployment flags every blocker rather than looking healthy", () => {
    // Only the schema defaults - i.e. someone deployed and set nothing.
    const bare = {
      DRY_RUN: true,
      ENABLE_SCHEDULER: false,
      DB_RLS_ENFORCE: true,
      TWILIO_CAMPAIGN_NUMBER_CAP: 49,
      RECEPTIONIST_MODEL: "claude-sonnet-5",
      SUPABASE_STORAGE_BUCKET: "shop-media",
      SQUARE_ENV: "sandbox",
    } as ApiEnv;
    const report = buildPreflight(bare, {
      billing: false,
      connect: false,
      email: false,
      push: false,
      wallet: false,
      square: false,
      receptionist: false,
    }, false);

    expect(report.blockers).toBeGreaterThan(0);
    // The five that make a shop unserviceable.
    for (const key of ["sends", "scheduler", "twilio_numbers", "receptionist", "email"]) {
      expect(find(report, key).ok, key).toBe(false);
      expect(find(report, key).severity, key).toBe("blocker");
    }
  });

  it("DRY_RUN on is a blocker, because sends silently succeed", () => {
    const report = buildPreflight(readyEnv({ DRY_RUN: true }), readyCaps, true);
    const check = find(report, "sends");
    expect(check.ok).toBe(false);
    expect(check.severity).toBe("blocker");
    expect(report.dryRun).toBe(true);
    expect(report.blockers).toBe(1);
  });

  it("reports per-shop number capacity from the campaign list, not just on/off", () => {
    const report = buildPreflight(
      readyEnv({ TWILIO_MESSAGING_SERVICE_SID: "MG1,MG2,MG3", TWILIO_CAMPAIGN_NUMBER_CAP: 10 }),
      readyCaps,
      true,
    );
    const check = find(report, "twilio_numbers");
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("3 A2P campaigns");
    expect(check.detail).toContain("30");
  });

  it("no messaging service is a blocker for per-shop numbers", () => {
    const report = buildPreflight(
      readyEnv({ TWILIO_MESSAGING_SERVICE_SID: undefined }),
      readyCaps,
      true,
    );
    expect(find(report, "twilio_numbers").ok).toBe(false);
    expect(find(report, "twilio_numbers").severity).toBe("blocker");
  });

  it("a missing WEB_PROXY_SECRET warns about the shared rate-limit bucket", () => {
    const report = buildPreflight(readyEnv(), readyCaps, false);
    const check = find(report, "web_proxy_secret");
    expect(check.ok).toBe(false);
    expect(check.severity).toBe("warn");
    expect(report.warnings).toBe(1);
  });

  it("never leaks a secret value into the report", () => {
    const secret = "sk_live_do_not_leak";
    const report = buildPreflight(
      readyEnv({
        STRIPE_PREMIUM_AI_PRICE_ID: secret,
        STRIPE_RECEPTIONIST_PRICE_ID: secret,
        TWILIO_MESSAGING_SERVICE_SID: secret,
        SUPABASE_SERVICE_ROLE_KEY: secret,
      }),
      readyCaps,
      true,
    );
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("every failing check explains the impact and names the fix", () => {
    const report = buildPreflight(
      readyEnv({ DRY_RUN: true, ENABLE_SCHEDULER: false }),
      { ...readyCaps, email: false, connect: false },
      false,
    );
    const failing = report.checks.filter((c) => !c.ok && c.severity !== "info");
    expect(failing.length).toBeGreaterThan(0);
    for (const c of failing) {
      expect(c.impact, c.key).toBeTruthy();
      expect(c.fix, c.key).toBeTruthy();
    }
  });

  it("passing checks carry no leftover impact/fix text", () => {
    const report = buildPreflight(readyEnv(), readyCaps, true);
    for (const c of report.checks) {
      expect(c.impact, c.key).toBeUndefined();
      expect(c.fix, c.key).toBeUndefined();
    }
  });

  describe("countMessagingServices", () => {
    it("tolerates whitespace, trailing commas and absence", () => {
      expect(countMessagingServices(undefined)).toBe(0);
      expect(countMessagingServices("")).toBe(0);
      expect(countMessagingServices("MG1")).toBe(1);
      expect(countMessagingServices(" MG1 , MG2 ,")).toBe(2);
    });
  });
});
