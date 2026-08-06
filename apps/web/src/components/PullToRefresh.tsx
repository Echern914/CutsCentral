"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Swipe-down-at-the-top to reload, for the phone (and especially the iOS app
 * shell, where there is no refresh button at all - a page that loaded stale or
 * mid-deploy was simply stuck).
 *
 * Touch-only by construction (touch events don't fire from a mouse). The pull
 * arms ONLY when the page is already scrolled to the very top and the first
 * movement is downward; anything else - scrolling up mid-page, horizontal
 * swipes - is ignored and native scrolling proceeds untouched. We never call
 * preventDefault, so this can't break scroll momentum; iOS's own overscroll
 * bounce coexists with the indicator (the gesture reads the finger, not the
 * scroll position).
 *
 * A full `location.reload()` on purpose, not router.refresh(): half the
 * dashboard's cards fetch client-side, and "refresh" from a barber means THE
 * PAGE, all of it, like the browser button they don't have in the app.
 */
const ARM_AT_PX = 80; // pull distance that triggers the reload
const MAX_PULL_PX = 130; // indicator stops following past this (resistance)

export function PullToRefresh() {
  const [pull, setPull] = useState(0); // resisted px the indicator shows
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const active = useRef(false);
  const refreshingRef = useRef(false);
  // The touch handlers subscribe once and read the live pull through this ref.
  const pullRef = useRef(0);
  pullRef.current = pull;

  useEffect(() => {
    const onStart = (e: TouchEvent) => {
      if (refreshingRef.current) return;
      // Only arm at the very top of the page - elsewhere it's a normal scroll.
      if (window.scrollY > 0) return;
      startY.current = e.touches[0]?.clientY ?? null;
      active.current = false;
    };
    const onMove = (e: TouchEvent) => {
      if (refreshingRef.current || startY.current === null) return;
      const y = e.touches[0]?.clientY;
      if (y === undefined) return;
      const delta = y - startY.current;
      // First movement decides: down = a pull, up = a scroll (disarm).
      if (!active.current) {
        if (delta < 8) {
          if (delta < 0) startY.current = null;
          return;
        }
        if (window.scrollY > 0) {
          startY.current = null;
          return;
        }
        active.current = true;
      }
      // Square-root resistance: the indicator trails the finger increasingly.
      const resisted = Math.min(MAX_PULL_PX, Math.sqrt(Math.max(0, delta)) * 8);
      setPull(resisted);
    };
    const end = () => {
      if (startY.current === null) return;
      const armed = active.current && pullRef.current >= ARM_AT_PX;
      startY.current = null;
      active.current = false;
      if (armed) {
        refreshingRef.current = true;
        setRefreshing(true);
        setPull(ARM_AT_PX); // hold the spinner in place while reloading
        window.location.reload();
      } else {
        setPull(0);
      }
    };
    // Passive listeners: we never preventDefault, so scrolling stays native.
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", end, { passive: true });
    window.addEventListener("touchcancel", end, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", end);
    };
  }, []);

  if (pull <= 0) return null;
  const armed = refreshing || pull >= ARM_AT_PX;

  return (
    <div
      aria-hidden={!refreshing}
      role={refreshing ? "status" : undefined}
      aria-label={refreshing ? "Refreshing" : undefined}
      className="pointer-events-none fixed inset-x-0 top-0 z-[70] flex justify-center"
      style={{ transform: `translateY(${Math.max(0, pull - 44)}px)` }}
    >
      <div
        className={
          "mt-2 flex h-10 w-10 items-center justify-center rounded-full border shadow-lg transition-colors " +
          (armed
            ? "border-gold/60 bg-charcoal-800 text-gold"
            : "border-subtle bg-charcoal-800 text-muted")
        }
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          className={
            "h-5 w-5 " + (refreshing ? "animate-spin" : "transition-transform")
          }
          style={
            refreshing
              ? undefined
              : { transform: `rotate(${Math.min(180, (pull / ARM_AT_PX) * 180)}deg)` }
          }
        >
          {refreshing ? (
            // Spinner arc while the reload kicks in.
            <path d="M21 12a9 9 0 1 1-3-6.7" />
          ) : (
            // Arrow that rotates to point up as the pull arms.
            <>
              <path d="M12 5v14" />
              <path d="m6 13 6 6 6-6" />
            </>
          )}
        </svg>
      </div>
    </div>
  );
}
