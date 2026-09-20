import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armBackgroundWorkTracking,
  backgroundWorkInFlight,
  disarmBackgroundWorkTracking,
  settleBackgroundWork,
  trackBackgroundWork,
} from "./backgroundWork.js";

/**
 * THE DRAIN'S OWN GUARANTEES.
 *
 * `staffUserLink.test.ts` proves the drain fixes the contamination it was
 * written for. This file proves the drain itself behaves under the conditions
 * that would silently reintroduce that contamination: a notification that
 * REJECTS, a dispatch that starts another mid-drain, a promise that never
 * settles, and production, where none of this may cost anything.
 *
 * Each one is a way the helper could look like it worked while leaving
 * something in flight - which is exactly the failure mode it exists to remove.
 */

afterEach(() => {
  disarmBackgroundWorkTracking();
});

describe("a rejected dispatch is still a finished dispatch", () => {
  it("🔴 one rejection does not abandon the rest of the drain", async () => {
    // With `Promise.all` the first rejection abandons the wait while the other
    // dispatches are still running - the same leak, reached another way. A
    // notification rejecting is ordinary: a provider is down, a push
    // subscription is stale.
    armBackgroundWorkTracking();
    let slowDone = false;

    trackBackgroundWork(Promise.reject(new Error("twilio is down"))).catch(() => {});
    trackBackgroundWork(
      new Promise<void>((r) => setTimeout(r, 60)).then(() => {
        slowDone = true;
      }),
    );

    await settleBackgroundWork();
    expect(slowDone).toBe(true);
    expect(backgroundWorkInFlight()).toBe(0);
  });

  it("does not surface a tracked rejection as an unhandled rejection", async () => {
    // The drain observes every tracked promise, so a caller that legitimately
    // ignores its own failure must not have that turned into a process-level
    // unhandled rejection by the act of tracking it.
    armBackgroundWorkTracking();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      // Deliberately NOT caught by the caller - a `void notify(...)` that fails.
      trackBackgroundWork(Promise.reject(new Error("push failed"))).catch(() => {});
      await settleBackgroundWork();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toHaveLength(0);
    expect(backgroundWorkInFlight()).toBe(0);
  });
});

describe("work registered WHILE draining is drained too", () => {
  it("🔴 a dispatch that starts another does not escape", async () => {
    // The real shape: a notify awaits a database read and only then sends. A
    // drain that looked once would return with the second leg newly in flight,
    // which is the whole failure mode again.
    armBackgroundWorkTracking();
    const order: string[] = [];

    trackBackgroundWork(
      new Promise<void>((r) => setTimeout(r, 20)).then(() => {
        order.push("first");
        // Registered mid-drain, from inside the first dispatch.
        trackBackgroundWork(
          new Promise<void>((r) => setTimeout(r, 20)).then(() => {
            order.push("second");
          }),
        );
      }),
    );

    await settleBackgroundWork();
    expect(order).toEqual(["first", "second"]);
    expect(backgroundWorkInFlight()).toBe(0);
  });

  it("drains a chain several links deep", async () => {
    armBackgroundWorkTracking();
    let depth = 0;
    const chain = (left: number): Promise<void> =>
      new Promise<void>((r) => setTimeout(r, 5)).then(() => {
        depth += 1;
        if (left > 0) trackBackgroundWork(chain(left - 1));
      });

    trackBackgroundWork(chain(4));
    await settleBackgroundWork();
    expect(depth).toBe(5);
    expect(backgroundWorkInFlight()).toBe(0);
  });
});

describe("🔴 a stuck dispatch fails the test, it does not hang the run", () => {
  it("gives up on a deadline, not after a count of iterations", async () => {
    // The bug in the first version of this helper: it bounded ROUNDS, which
    // bounds nothing. A promise that never settles hangs inside the FIRST round
    // forever and the loop counter is never reached. Only a deadline stops it.
    armBackgroundWorkTracking();
    trackBackgroundWork(new Promise<void>(() => {})); // never settles

    const started = Date.now();
    await expect(settleBackgroundWork({ timeoutMs: 150 })).rejects.toThrow(
      /did not settle within 150ms/,
    );
    const elapsed = Date.now() - started;
    // Bounded: it returned near the deadline rather than running forever.
    expect(elapsed).toBeLessThan(2000);
    expect(backgroundWorkInFlight()).toBe(1);
  });

  it("names the problem instead of raising the bound", async () => {
    armBackgroundWorkTracking();
    trackBackgroundWork(new Promise<void>(() => {}));
    await expect(settleBackgroundWork({ timeoutMs: 50 })).rejects.toThrow(
      /1 still in flight/,
    );
  });
});

describe("🔴 inert outside a test", () => {
  it("does not register anything when tracking was never armed", async () => {
    // Production. `inFlight` is null, so this is the default state of the
    // module in the running API - not something a deploy has to switch off.
    disarmBackgroundWorkTracking();
    const p = Promise.resolve("done");
    expect(trackBackgroundWork(p)).toBe(p); // the SAME promise, unwrapped
    expect(backgroundWorkInFlight()).toBe(0);
    // And a drain is a no-op rather than an error.
    await expect(settleBackgroundWork({ timeoutMs: 50 })).resolves.toBeUndefined();
  });

  it("returns the original promise when armed, so callers are unaffected", async () => {
    // `void notify(...)` and `await notify(...)` must behave identically either
    // way: tracking observes, it never substitutes.
    armBackgroundWorkTracking();
    const p = Promise.resolve("value");
    expect(trackBackgroundWork(p)).toBe(p);
    await expect(trackBackgroundWork(Promise.resolve(7))).resolves.toBe(7);

    const boom = new Error("still rejects");
    await expect(trackBackgroundWork(Promise.reject(boom))).rejects.toBe(boom);
    await settleBackgroundWork();
  });

  it("stops counting once disarmed", async () => {
    armBackgroundWorkTracking();
    trackBackgroundWork(new Promise<void>((r) => setTimeout(r, 10)));
    expect(backgroundWorkInFlight()).toBe(1);

    disarmBackgroundWorkTracking();
    expect(backgroundWorkInFlight()).toBe(0);
    trackBackgroundWork(new Promise<void>((r) => setTimeout(r, 10)));
    expect(backgroundWorkInFlight()).toBe(0);
  });
});

describe("the ordinary case", () => {
  it("returns immediately when nothing is outstanding", async () => {
    armBackgroundWorkTracking();
    const started = Date.now();
    await settleBackgroundWork();
    // No sleeping, no waiting on a timer it forgot to clear: the drain must be
    // cheap enough to sit in an afterEach on every test in a file.
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("counts what is outstanding while it runs", async () => {
    armBackgroundWorkTracking();
    trackBackgroundWork(new Promise<void>((r) => setTimeout(r, 30)));
    trackBackgroundWork(new Promise<void>((r) => setTimeout(r, 30)));
    expect(backgroundWorkInFlight()).toBe(2);
    await settleBackgroundWork();
    expect(backgroundWorkInFlight()).toBe(0);
  });
});
