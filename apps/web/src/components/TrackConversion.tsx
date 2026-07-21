"use client";

import { useEffect } from "react";
import { track } from "@/lib/analytics";

/**
 * Fires a conversion event exactly once when it mounts, then remembers it in
 * sessionStorage under `dedupeKey` so a page refresh / back-nav doesn't
 * re-count. Rendered by server pages at the point a conversion is confirmed
 * (signup → /onboarding, purchase → billing ?checkout=success). Renders nothing.
 */
export function TrackConversion({
  event,
  dedupeKey,
  value,
}: {
  event: "signup" | "purchase";
  dedupeKey: string;
  value?: number;
}) {
  useEffect(() => {
    const key = `cb_tracked:${dedupeKey}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      // Private mode / storage disabled: fall through and fire anyway (a rare
      // double-count is better than silently dropping the conversion).
    }
    track(event, value != null ? { value, currency: "USD" } : undefined);
  }, [event, dedupeKey, value]);

  return null;
}
