import { describe, expect, it } from "vitest";
import { buildPreflight, type PreflightCapabilities, type WebConfigReport } from "./preflight.js";
import { apiEnv } from "@chairback/config";

/**
 * The half of the deployment this report could not previously see.
 *
 * `buildPreflight` runs in the API process and reads Railway's environment.
 * Analytics, the push public key and the Android fingerprint live in Vercel's,
 * and NEXT_PUBLIC_* are inlined at ITS build time - so the report was healthy
 * for months while four integrations were off. These pin that the web half is
 * now represented, and that "could not check" is stated rather than assumed OK.
 */

const CAPS: PreflightCapabilities = {
  billing: true,
  connect: true,
  email: true,
  push: true,
  wallet: true,
  square: true,
  receptionist: true,
};

const ALL_ON: WebConfigReport = {
  posthog: true,
  metaPixel: true,
  pushPublicKey: true,
  androidAppLinks: true,
};

const find = (r: ReturnType<typeof buildPreflight>, key: string) =>
  r.checks.find((c) => c.key === key);

describe("the web half of the preflight", () => {
  it("🔴 an unreachable web app is REPORTED, never assumed healthy", () => {
    const r = buildPreflight(apiEnv(), CAPS, true, null);
    const c = find(r, "web.reachable");
    expect(c?.ok).toBe(false);
    expect(c?.severity).toBe("warn");
    // And it must not silently claim the individual integrations are fine.
    expect(find(r, "web.analytics")).toBeUndefined();
  });

  it("🔴 analytics off is a WARNING that explains why nobody noticed", () => {
    const r = buildPreflight(apiEnv(), CAPS, true, {
      ...ALL_ON,
      posthog: false,
      metaPixel: false,
    });
    const c = find(r, "web.analytics");
    expect(c?.ok).toBe(false);
    expect(c?.severity).toBe("warn");
    expect(c?.detail).toMatch(/PostHog OFF/);
    expect(c?.detail).toMatch(/Meta Pixel OFF/);
    // The failure mode is the point: silence looks like no conversions.
    expect(c?.impact).toMatch(/zero by omission/i);
    // And the fix must mention the redeploy, or setting the var appears to do
    // nothing (NEXT_PUBLIC_* are inlined at build time).
    expect(c?.fix).toMatch(/redeploy/i);
  });

  it("one analytics sink is enough to be considered on", () => {
    const r = buildPreflight(apiEnv(), CAPS, true, { ...ALL_ON, metaPixel: false });
    expect(find(r, "web.analytics")?.ok).toBe(true);
  });

  it("🔴 push needs BOTH halves - a public key with no private pair is not offerable", () => {
    const withApiKeys = buildPreflight(apiEnv(), CAPS, true, ALL_ON);
    expect(find(withApiKeys, "web.push_public_key")?.ok).toBe(true);

    const noApiPair = buildPreflight(apiEnv(), { ...CAPS, push: false }, true, ALL_ON);
    const c = find(noApiPair, "web.push_public_key");
    expect(c?.ok).toBe(false);
    expect(c?.detail).toMatch(/API has no VAPID pair/i);
  });

  it("a missing Android fingerprint is INFO, not a warning", () => {
    // There is no published Android build, and a WRONG fingerprint is worse
    // than none because Android caches the failed verification. Absent is the
    // correct state, so it must not inflate the warning count.
    const off = buildPreflight(apiEnv(), CAPS, true, { ...ALL_ON, androidAppLinks: false });
    const on = buildPreflight(apiEnv(), CAPS, true, ALL_ON);
    const c = find(off, "web.android_app_links");
    expect(c?.ok).toBe(false);
    expect(c?.severity).toBe("info");
    // Asserted as a DELTA, not an absolute: this suite shares an environment
    // with whatever else is unset, so the property is "android contributes no
    // warning", not "there are no warnings".
    expect(off.warnings).toBe(on.warnings);
  });

  it("carries no secrets - keys, ids and fingerprints never appear", () => {
    const flat = JSON.stringify(buildPreflight(apiEnv(), CAPS, true, ALL_ON));
    expect(flat).not.toMatch(/phc_|sk_live|sk_test|BEGIN PRIVATE KEY/);
  });
});
