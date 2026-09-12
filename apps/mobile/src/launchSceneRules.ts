/**
 * The decisions behind the launch scene, kept pure so they can be tested
 * without rendering anything. The component (LaunchScene.tsx) only draws.
 *
 * Named "Rules" rather than "launchScene" because macOS is case-insensitive:
 * a `launchScene.ts` beside `LaunchScene.tsx` resolves ambiguously and
 * TypeScript rightly refuses (TS1149).
 */

/**
 * 🔴 HARD CAP. The sum of every phase is the longest the overlay can ever be on
 * screen, and it is deliberately just over a second: long enough to read as an
 * opening, short enough that nobody who opened the app to check their next
 * appointment notices they waited. Anything that would push this past ~1.2s
 * is the wrong change.
 */
export const LAUNCH_SCENE_MAX_MS = 1200;

export interface LaunchSceneTiming {
  /** Frame one held still, so the splash handoff is invisible. */
  holdMs: number;
  /** The blade of light crossing the mark. 0 under Reduce Motion. */
  sweepMs: number;
  /** The mark lifting and the wordmark arriving. 0 under Reduce Motion. */
  liftMs: number;
  /** A breath on the finished frame. 0 under Reduce Motion. */
  settleMs: number;
  /** The cross-fade out over the app. */
  fadeOutMs: number;
}

/**
 * Timings for one play. Under Reduce Motion the three moving beats are dropped
 * and only the hold and the fade remain, so the scene becomes a calm dissolve
 * rather than a sweep - honouring the setting instead of merely shortening it.
 */
export function launchSceneTiming(reduceMotion: boolean): LaunchSceneTiming {
  const t: LaunchSceneTiming = reduceMotion
    ? { holdMs: 250, sweepMs: 0, liftMs: 0, settleMs: 0, fadeOutMs: 300 }
    : { holdMs: 120, sweepMs: 420, liftMs: 300, settleMs: 100, fadeOutMs: 240 };
  return t;
}

/** The total the timing adds up to - what the cap is checked against. */
export function launchSceneTotalMs(t: LaunchSceneTiming): number {
  return t.holdMs + t.sweepMs + t.liftMs + t.settleMs + t.fadeOutMs;
}

/**
 * 🔴 COLD START ONLY, and this is the whole mechanism.
 *
 * A module-level variable is reset when the process starts and survives
 * everything else: foregrounding, a route change, a WebView reload. So the
 * first mount in a process plays the scene and every later one does not.
 * Deliberately NOT persisted to storage: the point is "once per launch", not
 * "once ever" - a returning user still gets the opening, just never twice in
 * one sitting.
 *
 * Exposed as a function (with a reset for tests) rather than a bare boolean so
 * the rule has one owner.
 */
let played = false;

export function shouldPlayLaunchScene(): boolean {
  if (played) return false;
  played = true;
  return true;
}

/** Test-only: pretend the process just started. */
export function __resetLaunchSceneForTests(): void {
  played = false;
}
