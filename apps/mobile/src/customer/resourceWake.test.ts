import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WakeSources } from "./announcementWake";
import {
  PUSH_SETTLE_MS,
  WAKE_MIN_GAP_MS,
  connectResourceWake,
  createResourceWakeBus,
  shouldRefetchOnWake,
  type ResourceWakeReason,
} from "./resourceWake";

/** Two fake event sources the test can fire, and see unsubscribed. */
function fakeSources() {
  const app = new Set<(s: string) => void>();
  const notes = new Set<(d: unknown) => void>();
  const sources: WakeSources = {
    onAppState: (l) => {
      app.add(l);
      return { remove: () => void app.delete(l) };
    },
    onNotificationReceived: (l) => {
      notes.add(l);
      return { remove: () => void notes.delete(l) };
    },
  };
  return {
    sources,
    appState: (s: string) => app.forEach((l) => l(s)),
    notify: (data: unknown) => notes.forEach((l) => l(data)),
    listeners: () => app.size + notes.size,
  };
}

/**
 * A mounted resource as useResource wires it: it subscribes to the bus and
 * reads when shouldRefetchOnWake says so. `finish()` lands its request.
 */
function fakeResource(bus: ReturnType<typeof createResourceWakeBus>, clock: () => number) {
  const state = { lastFetchAt: null as number | null, inFlight: false, reads: 0 };
  const read = () => {
    state.inFlight = true;
    state.lastFetchAt = clock();
    state.reads++;
  };
  const stop = bus.subscribe((reason) => {
    if (!shouldRefetchOnWake(reason, state.lastFetchAt, clock(), state.inFlight)) return;
    read();
  });
  return { state, read, finish: () => void (state.inFlight = false), stop };
}

describe("shouldRefetchOnWake", () => {
  const now = 1_000_000;

  it("reads on a foreground flip when it has never read, or last read long enough ago", () => {
    expect(shouldRefetchOnWake("foreground", null, now, false)).toBe(true);
    expect(shouldRefetchOnWake("foreground", now - WAKE_MIN_GAP_MS, now, false)).toBe(true);
    expect(shouldRefetchOnWake("foreground", now - 60_000, now, false)).toBe(true);
  });

  it("does not read again on a foreground flip within ~5s of the last read", () => {
    expect(WAKE_MIN_GAP_MS).toBeGreaterThanOrEqual(5000);
    expect(shouldRefetchOnWake("foreground", now - 1, now, false)).toBe(false);
    expect(shouldRefetchOnWake("foreground", now - (WAKE_MIN_GAP_MS - 1), now, false)).toBe(false);
  });

  it("never reads while its own request is in flight - foreground or push", () => {
    expect(shouldRefetchOnWake("foreground", null, now, true)).toBe(false);
    expect(shouldRefetchOnWake("foreground", now - 60_000, now, true)).toBe(false);
    expect(shouldRefetchOnWake("push", now - 60_000, now, true)).toBe(false);
  });

  it("a push reads even right after another read: it says something just changed", () => {
    expect(shouldRefetchOnWake("push", now - 1, now, false)).toBe(true);
    expect(shouldRefetchOnWake("push", null, now, false)).toBe(true);
  });
});

describe("the customer's screens read again when the app comes back", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returning to the foreground re-reads every mounted resource (a moved booking shows)", () => {
    const f = fakeSources();
    const bus = createResourceWakeBus();
    connectResourceWake(f.sources, bus);
    const home = fakeResource(bus, Date.now);
    const appointments = fakeResource(bus, Date.now);
    const detail = fakeResource(bus, Date.now);

    f.appState("background");
    f.appState("inactive");
    expect([home.state.reads, appointments.state.reads, detail.state.reads]).toEqual([0, 0, 0]);

    f.appState("active");
    expect([home.state.reads, appointments.state.reads, detail.state.reads]).toEqual([1, 1, 1]);
  });

  it("rapid foreground flips read once per ~5s, and never on top of a request in flight", () => {
    const f = fakeSources();
    const bus = createResourceWakeBus();
    connectResourceWake(f.sources, bus);
    const home = fakeResource(bus, Date.now);

    f.appState("active");
    expect(home.state.reads).toBe(1);
    // Still in flight: a flip now reads nothing, however long it takes.
    vi.advanceTimersByTime(WAKE_MIN_GAP_MS + 1);
    f.appState("active");
    expect(home.state.reads).toBe(1);

    home.finish();
    f.appState("active");
    expect(home.state.reads).toBe(2);
    home.finish();

    // Flicking in and out of the app: nothing until the gap has passed.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(500);
      f.appState("background");
      f.appState("active");
    }
    expect(home.state.reads).toBe(2);
    vi.advanceTimersByTime(WAKE_MIN_GAP_MS);
    f.appState("active");
    expect(home.state.reads).toBe(3);
  });

  it("a push while open re-reads after it settles; a burst of pushes is one read", () => {
    const f = fakeSources();
    const bus = createResourceWakeBus();
    connectResourceWake(f.sources, bus);
    const home = fakeResource(bus, Date.now);
    home.read(); // the screen's own focus read, just now
    home.finish();

    f.notify({ url: "https://example.test/book/shop" });
    f.notify(null);
    f.notify({ anything: 1 });
    expect(home.state.reads).toBe(1);
    vi.advanceTimersByTime(PUSH_SETTLE_MS - 1);
    expect(home.state.reads).toBe(1);
    vi.advanceTimersByTime(1);
    // Read even though the last read was under 5s ago.
    expect(home.state.reads).toBe(2);
  });

  it("an unmounted screen stops listening; disconnecting stops everything", () => {
    const f = fakeSources();
    const bus = createResourceWakeBus();
    const stop = connectResourceWake(f.sources, bus);
    const home = fakeResource(bus, Date.now);
    const detail = fakeResource(bus, Date.now);
    expect(bus.size()).toBe(2);

    detail.stop();
    expect(bus.size()).toBe(1);
    f.appState("active");
    expect([home.state.reads, detail.state.reads]).toEqual([1, 0]);
    home.finish();

    // Signed out: the provider disconnects. A push already settling is dropped.
    f.notify({});
    expect(f.listeners()).toBe(2);
    stop();
    expect(f.listeners()).toBe(0);
    vi.advanceTimersByTime(60_000);
    f.appState("active");
    expect(home.state.reads).toBe(1);
  });

  it("one screen throwing does not stop the others reading", () => {
    const bus = createResourceWakeBus();
    const seen: ResourceWakeReason[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((r) => seen.push(r));
    expect(() => bus.wake("foreground")).not.toThrow();
    expect(seen).toEqual(["foreground"]);
  });
});
