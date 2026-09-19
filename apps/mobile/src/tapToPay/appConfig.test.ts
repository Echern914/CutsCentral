import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExpoConfig } from "expo/config";

/**
 * THE TWO BUILDS `app.config.ts` CAN GENERATE.
 *
 * 🔴 WHY THIS FILE EXISTS. The Apple Tap to Pay entitlement is granted per
 * bundle id, on request, and a build that declares one the account has not been
 * granted **fails to sign**. So the default build must not declare it - and
 * "must not" is worth a test rather than a comment, because the failure lands
 * on whoever is trying to ship something unrelated.
 *
 * The other half is the invariant underneath: the entitlement and the shell's
 * capability announcement are ONE decision. A binary that advertises Tap to Pay
 * without the entitlement hands the barber a button that dies at the reader
 * with a customer standing in front of them, which is worse than not offering
 * it. Both tests below assert them together, never separately.
 */

const STRIPE_TERMINAL_PLUGIN = "@stripe/stripe-terminal-react-native";
const ENTITLEMENT = "com.apple.developer.proximity-reader.payment.acceptance";

/** Evaluate app.config.ts fresh, with the flag in a given state. */
async function generate(flag: string | undefined): Promise<ExpoConfig> {
  vi.resetModules();
  const previous = process.env.TAP_TO_PAY_NATIVE_ENABLED;
  if (flag === undefined) delete process.env.TAP_TO_PAY_NATIVE_ENABLED;
  else process.env.TAP_TO_PAY_NATIVE_ENABLED = flag;
  try {
    const mod = await import("../../app.config");
    // Expo hands the config function whatever it read from disk; nothing in
    // this app depends on that, so an empty base is faithful enough.
    return mod.default({ config: {} } as never);
  } finally {
    if (previous === undefined) delete process.env.TAP_TO_PAY_NATIVE_ENABLED;
    else process.env.TAP_TO_PAY_NATIVE_ENABLED = previous;
  }
}

/** Plugin entries are either "name" or ["name", {...}]. */
function pluginNames(config: ExpoConfig): string[] {
  return (config.plugins ?? []).map((p) => (Array.isArray(p) ? String(p[0]) : String(p)));
}

afterEach(() => {
  vi.resetModules();
});

describe("the DEFAULT build - the one that has to keep shipping", () => {
  it("🔴 declares NO Apple entitlement, so it signs like every build before it", async () => {
    const config = await generate(undefined);
    expect(config.ios?.entitlements).toBeUndefined();
  });

  it("🔴 does not announce Tap to Pay, because this binary cannot do it", async () => {
    const config = await generate(undefined);
    expect(config.extra?.tapToPayNativeEnabled).toBe(false);
  });

  it("leaves out the Terminal plugin, so iOS is never asked for location", async () => {
    // A build that cannot take a contactless payment has nothing to justify
    // a location permission string with, and App Review may ask.
    const config = await generate(undefined);
    expect(pluginNames(config)).not.toContain(STRIPE_TERMINAL_PLUGIN);
  });

  it("changes NOTHING else - the rest of the app is untouched by the flag", async () => {
    const off = await generate(undefined);
    const on = await generate("true");
    expect(off.ios?.bundleIdentifier).toBe("com.getchairback.rewards");
    expect(off.ios?.bundleIdentifier).toBe(on.ios?.bundleIdentifier);
    expect(off.ios?.buildNumber).toBe(on.ios?.buildNumber);
    expect(off.ios?.associatedDomains).toEqual(on.ios?.associatedDomains);
    // Every plugin the app already had is still there, in the same order.
    const others = pluginNames(on).filter((n) => n !== STRIPE_TERMINAL_PLUGIN);
    expect(pluginNames(off)).toEqual(others);
    expect(pluginNames(off)).toContain("expo-router");
    expect(pluginNames(off)).toContain("expo-secure-store");
  });
});

describe("the ENABLED build - only once Apple has granted it", () => {
  it("declares the entitlement and announces the capability, together", async () => {
    const config = await generate("true");
    expect(config.ios?.entitlements?.[ENTITLEMENT]).toBe(true);
    expect(config.extra?.tapToPayNativeEnabled).toBe(true);
  });

  it("adds the Terminal plugin with the location string its SDK requires", async () => {
    const config = await generate("true");
    const entry = (config.plugins ?? []).find(
      (p) => Array.isArray(p) && p[0] === STRIPE_TERMINAL_PLUGIN,
    ) as [string, Record<string, unknown>] | undefined;
    expect(entry).toBeDefined();
    expect(entry?.[1]?.locationWhenInUsePermission).toMatch(/card payments/i);
    expect(entry?.[1]?.bluetoothBackgroundMode).toBe(false);
  });

  it("accepts 1 as well as true, and is not case-sensitive", async () => {
    expect((await generate("1")).extra?.tapToPayNativeEnabled).toBe(true);
    expect((await generate("TRUE")).extra?.tapToPayNativeEnabled).toBe(true);
    expect((await generate(" true ")).extra?.tapToPayNativeEnabled).toBe(true);
  });
});

describe("🔴 the entitlement and the announcement can never disagree", () => {
  it("every accepted value moves both, or neither", async () => {
    // The invariant this whole flag exists to hold. If these two ever come
    // apart, one of the halves is lying to a barber mid-checkout.
    for (const flag of [undefined, "", "false", "0", "no", "yes", "true", "1"]) {
      const config = await generate(flag);
      const entitled = config.ios?.entitlements?.[ENTITLEMENT] === true;
      const announced = config.extra?.tapToPayNativeEnabled === true;
      const plugged = pluginNames(config).includes(STRIPE_TERMINAL_PLUGIN);
      expect({ flag, entitled, announced, plugged }).toEqual({
        flag,
        entitled: announced,
        announced,
        plugged: announced,
      });
    }
  });

  it("anything unrecognised reads as OFF, never as on", async () => {
    // A typo in a build script must not be what puts an ungranted entitlement
    // into a binary.
    for (const flag of ["yes", "on", "TAP", "2", "true!", " "]) {
      const config = await generate(flag);
      expect(config.extra?.tapToPayNativeEnabled).toBe(false);
      expect(config.ios?.entitlements).toBeUndefined();
    }
  });
});
