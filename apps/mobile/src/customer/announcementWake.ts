import { routeForNotification } from "../pushTap";

/**
 * When the bell has to look again without being asked.
 *
 * A screen's data refetches on FOCUS - and the moments an announcement
 * actually arrives are not focus changes:
 *   - the app comes back from the background (iOS kept it in memory, still
 *     on Home), after a push landed on the lock screen;
 *   - a push arrives while the app is open (the banner shows, the screen stays
 *     where it is);
 *   - the customer taps that banner while Announcements is already on top,
 *     which navigates nowhere.
 * Without this the badge and the list stayed as they were until a pull or a
 * tab switch.
 *
 * Pure on purpose, like pushTap.ts: the event sources are handed in, so the
 * rule is tested without a device. The hook that wires it to AppState and
 * expo-notifications is useAnnouncementWake.ts.
 */

export interface WakeSources {
  /** AppState "change" events: "active", "background", "inactive". */
  onAppState(listener: (state: string) => void): { remove(): void };
  /** A notification received while the app is running - its `data`. */
  onNotificationReceived(listener: (data: unknown) => void): { remove(): void };
}

/** Why the bell is looking again. */
export type WakeReason = "foreground" | "announcement";

/** Subscribe; returns the unsubscribe. */
export function subscribeAnnouncementWake(
  sources: WakeSources,
  wake: (reason: WakeReason) => void,
): () => void {
  const app = sources.onAppState((state) => {
    if (state === "active") wake("foreground");
  });
  const note = sources.onNotificationReceived((data) => {
    // The same rule that decides where a TAP goes decides what is an
    // announcement - one place, pushTap.ts.
    if (routeForNotification(data) === "/customer/announcements") wake("announcement");
  });
  return () => {
    app.remove();
    note.remove();
  };
}
