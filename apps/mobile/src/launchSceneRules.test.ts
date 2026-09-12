import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetLaunchSceneForTests,
  LAUNCH_SCENE_MAX_MS,
  launchSceneTiming,
  launchSceneTotalMs,
  shouldPlayLaunchScene,
} from "./launchSceneRules";

/**
 * The opening cut's two promises, pinned where they can be checked without a
 * renderer: it plays once per launch, and it can never make the app slower to
 * use than the number at the top of launchScene.ts.
 */

beforeEach(() => __resetLaunchSceneForTests());

describe("🔴 it may never make the app slower", () => {
  it("the full sequence stays under the hard cap", () => {
    const t = launchSceneTiming(false);
    expect(launchSceneTotalMs(t)).toBeLessThanOrEqual(LAUNCH_SCENE_MAX_MS);
    // And the cap itself is a cap - not something that drifted upward to fit.
    expect(LAUNCH_SCENE_MAX_MS).toBeLessThanOrEqual(1200);
  });

  it("Reduce Motion is honoured, not merely shortened", () => {
    const t = launchSceneTiming(true);
    // Every moving beat is gone; what is left is a hold and a dissolve.
    expect(t.sweepMs).toBe(0);
    expect(t.liftMs).toBe(0);
    expect(t.settleMs).toBe(0);
    expect(t.fadeOutMs).toBeGreaterThan(0);
    expect(launchSceneTotalMs(t)).toBeLessThanOrEqual(LAUNCH_SCENE_MAX_MS);
  });

  it("frame one is held still long enough to hand off from the splash", () => {
    // Zero here would let the sweep start on the very frame the native splash
    // disappears - which reads as a pop, and a pop reads as a bug.
    expect(launchSceneTiming(false).holdMs).toBeGreaterThan(0);
  });
});

describe("🔴 cold start only", () => {
  it("plays on the first ask of a process and never again", () => {
    expect(shouldPlayLaunchScene()).toBe(true);
    expect(shouldPlayLaunchScene()).toBe(false);
    expect(shouldPlayLaunchScene()).toBe(false);
  });

  it("a fresh process plays it again - it is per launch, not once ever", () => {
    expect(shouldPlayLaunchScene()).toBe(true);
    __resetLaunchSceneForTests();
    expect(shouldPlayLaunchScene()).toBe(true);
  });
});
