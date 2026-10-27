import type { WakeSources } from "./announcementWake";

/**
 * When the customer's screens read their data again without being asked.
 *
 * Every `useResource` (CustomerProvider.tsx) refetches on FOCUS and on a pull.
 * Coming back from the background is neither: iOS keeps the app in memory,
 * still on the same screen, so nothing focuses. A barber who moved a booking
 * while the app was in the background left the customer looking at the OLD
 * time until they pulled to refresh - the server had the new time all along.
 * A push arriving while the app is open (the reminder, the "your booking
 * moved" text) is the same: the banner shows, the screen stays as it was.
 *
 * So the provider owns ONE listener (AppState + notifications received) and
 * fans a wake out to every mounted resource. Each resource decides for itself
 * whether to go: never while its own request is still out, and - for a
 * foreground flip - not again within WAKE_MIN_GAP_MS of its last request, so
 * flicking between apps doesn't fire a request per flick. Refetching keeps the
 * cached data on screen (no spinner); only the answer replaces it.
 *
 * Pure on purpose, like announcementWake.ts: the event sources and the clock
 * are handed in, so the rule is tested without a device.
 */

/** A foreground flip within this long of the last request reads nothing. */
export const WAKE_MIN_GAP_MS = 5000;

/**
 * How long after a push lands to read again. The worker sends the push a
 * moment BEFORE it records what it sent (see useAnnouncementWake.ts), so a read
 * the instant the banner shows can come back without it.
 */
export const PUSH_SETTLE_MS = 2000;

/** Why the screens are looking again. */
export type ResourceWakeReason = "foreground" | "push";

/**
 * Should a mounted resource refetch for this wake?
 *
 * - Never while its own request is in flight: that answer is on its way.
 * - A push always reads (once settled): it says something just changed.
 * - A foreground flip reads unless the last request STARTED under
 *   `minGapMs` ago. No request yet (null) always reads.
 */
export function shouldRefetchOnWake(
  reason: ResourceWakeReason,
  lastFetchAt: number | null,
  now: number,
  inFlight: boolean,
  minGapMs: number = WAKE_MIN_GAP_MS,
): boolean {
  if (inFlight) return false;
  if (reason === "push") return true;
  if (lastFetchAt === null) return true;
  return now - lastFetchAt >= minGapMs;
}

/** The fan-out: mounted resources subscribe; the provider's listener wakes them all. */
export interface ResourceWakeBus {
  subscribe(listener: (reason: ResourceWakeReason) => void): () => void;
  wake(reason: ResourceWakeReason): void;
  /** How many resources are listening (tests). */
  size(): number;
}

export function createResourceWakeBus(): ResourceWakeBus {
  const listeners = new Set<(reason: ResourceWakeReason) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    wake(reason) {
      // A copy: a listener may unsubscribe (a screen unmounting) mid-loop.
      for (const listener of [...listeners]) {
        try {
          listener(reason);
        } catch {
          // One screen's failure must not stop the others reading.
        }
      }
    },
    size: () => listeners.size,
  };
}

/** The one bus the app uses; CustomerProvider wakes it, useResource listens. */
export const resourceWake: ResourceWakeBus = createResourceWakeBus();

/**
 * Wire the app's events to a bus: "active" wakes it at once; any notification
 * received while open wakes it PUSH_SETTLE_MS later (a burst of pushes is one
 * read). Returns the unsubscribe, which also cancels a pending settle.
 */
export function connectResourceWake(sources: WakeSources, bus: ResourceWakeBus): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const app = sources.onAppState((state) => {
    if (state === "active") bus.wake("foreground");
  });
  const note = sources.onNotificationReceived(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      bus.wake("push");
    }, PUSH_SETTLE_MS);
  });
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    app.remove();
    note.remove();
  };
}
