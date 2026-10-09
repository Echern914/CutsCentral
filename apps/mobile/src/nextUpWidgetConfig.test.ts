import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExpoConfig } from "expo/config";
import { WIDGET_KEYS } from "./nextUpWidget";

/**
 * THE LOCK SCREEN WIDGET'S BUILD FLAG.
 *
 * 🔴 The default build must be exactly the build that ships today: a second
 * signed target with an App Group fails to sign until the group exists on the
 * Apple account, and that must not be the cost of an unrelated release. So the
 * plugin, the entitlement, the team id and the shell's announcement all hang
 * off NEXT_UP_WIDGET_ENABLED, together.
 */

const PLUGIN = "@bacons/apple-targets";
const GROUP_KEY = "com.apple.security.application-groups";
const TTP_KEY = "com.apple.developer.proximity-reader.payment.acceptance";

async function generate(env: { widget?: string; ttp?: string }): Promise<ExpoConfig> {
  vi.resetModules();
  const prev = { widget: process.env.NEXT_UP_WIDGET_ENABLED, ttp: process.env.TAP_TO_PAY_NATIVE_ENABLED };
  const put = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  put("NEXT_UP_WIDGET_ENABLED", env.widget);
  put("TAP_TO_PAY_NATIVE_ENABLED", env.ttp);
  try {
    const mod = await import("../app.config");
    return mod.default({ config: {} } as never);
  } finally {
    put("NEXT_UP_WIDGET_ENABLED", prev.widget);
    put("TAP_TO_PAY_NATIVE_ENABLED", prev.ttp);
  }
}

const pluginNames = (c: ExpoConfig) => (c.plugins ?? []).map((p) => (Array.isArray(p) ? String(p[0]) : String(p)));

afterEach(() => {
  vi.resetModules();
});

describe("the widget flag", () => {
  it("🔴 off (the default): no widget target, no App Group, no team id, nothing announced", async () => {
    const c = await generate({});
    expect(pluginNames(c)).not.toContain(PLUGIN);
    expect(c.ios?.entitlements).toBeUndefined();
    expect(c.ios?.appleTeamId).toBeUndefined();
    expect(c.extra?.nextUpWidgetEnabled).toBe(false);
  });

  it("on: the target, the App Group, the team id and the announcement - together", async () => {
    const c = await generate({ widget: "true" });
    expect(pluginNames(c)).toContain(PLUGIN);
    expect(c.ios?.entitlements?.[GROUP_KEY]).toEqual(["group.com.getchairback.rewards"]);
    expect(c.ios?.entitlements?.[TTP_KEY]).toBeUndefined();
    expect(c.ios?.appleTeamId).toBe("ZLP9T7HSYJ");
    expect(c.extra?.nextUpWidgetEnabled).toBe(true);
    expect(c.extra?.nextUpAppGroup).toBe("group.com.getchairback.rewards");
  });

  it("with Tap to Pay too, both entitlements stand - neither flag erases the other", async () => {
    const c = await generate({ widget: "true", ttp: "true" });
    expect(c.ios?.entitlements?.[GROUP_KEY]).toEqual(["group.com.getchairback.rewards"]);
    expect(c.ios?.entitlements?.[TTP_KEY]).toBe(true);
  });

  it("🔴 the widget target names the SAME App Group as the app - mirrored, never typed twice", async () => {
    const c = await generate({ widget: "true" });
    const require = createRequire(import.meta.url);
    const target = require("../targets/next-up/expo-target.config.js") as (config: ExpoConfig) => {
      type: string;
      entitlements: Record<string, unknown>;
    };
    const made = target(c);
    expect(made.type).toBe("widget");
    expect(made.entitlements[GROUP_KEY]).toEqual(c.ios?.entitlements?.[GROUP_KEY]);
  });

  it("🔴 the Swift reads the group and the keys the app writes - a typo would be a widget that never fills", async () => {
    const c = await generate({ widget: "true" });
    const swift = readFileSync(fileURLToPath(new URL("../targets/next-up/NextUpWidget.swift", import.meta.url).href), "utf8");
    expect(swift).toContain(`let appGroup = "${String(c.extra?.nextUpAppGroup)}"`);
    for (const [name, key] of Object.entries(WIDGET_KEYS)) {
      expect(swift, name).toContain(`static let ${name} = "${key}"`);
    }
  });
});
