"use client";

import { useEffect, useRef } from "react";

/**
 * Poll `fn` every `intervalMs` - but only while the tab is actually VISIBLE.
 *
 * Extracted from BookingCalendar's inline agenda poll (the only
 * visibility-aware poll in the repo) so the walk-in surfaces don't grow a
 * second, slightly different copy. A backgrounded tablet or a phone with the
 * screen off stops asking; the next foreground paint resumes on schedule.
 *
 * `fn` is kept in a ref so callers can pass a fresh closure every render
 * without resetting the interval.
 */
export function useVisiblePoll(
  fn: () => void | Promise<void>,
  intervalMs: number,
  enabled = true,
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const iv = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void fnRef.current();
    }, intervalMs);
    return () => clearInterval(iv);
  }, [intervalMs, enabled]);
}
