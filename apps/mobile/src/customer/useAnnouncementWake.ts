import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import * as Notifications from "expo-notifications";
import { subscribeAnnouncementWake } from "./announcementWake";

/**
 * Reload the announcements a screen shows when the app returns to the
 * foreground, or an announcement push arrives while it is open
 * (announcementWake.ts says why focus alone is not enough). Used by the
 * home's bell and by the Announcements screen.
 */
export function useAnnouncementWake(reload: () => Promise<void>): void {
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = subscribeAnnouncementWake(
      {
        onAppState: (listener) => AppState.addEventListener("change", listener),
        onNotificationReceived: (listener) =>
          Notifications.addNotificationReceivedListener((n) => listener(n.request.content.data)),
      },
      (reason) => {
        if (reason === "foreground") {
          void latest.current();
          return;
        }
        // The worker sends the push a moment BEFORE it records the send, so
        // a read the instant the banner lands can come back without it.
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void latest.current(), SETTLE_MS);
      },
    );
    return () => {
      if (timer) clearTimeout(timer);
      stop();
    };
  }, []);
}

/** How long after an announcement push to read the list again. */
const SETTLE_MS = 2000;
