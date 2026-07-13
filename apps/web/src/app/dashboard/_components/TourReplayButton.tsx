"use client";

import { writeTourStep } from "@/components/tour/state";

/**
 * Restart the interactive dashboard tour from step 1. Writes the tour state
 * directly (no navigation): the DemoTour overlay mounted on this page picks it
 * up instantly via the shared step event. Overview hosts step 1, so the
 * spotlight appears right here — no reload, no redirect.
 */
export function TourReplayButton() {
  return (
    <button
      type="button"
      onClick={() => writeTourStep("dashboard", 1)}
      className="inline-flex w-fit items-center gap-1.5 text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite"
    >
      <svg
        className="h-3.5 w-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 4v5h5" />
      </svg>
      Take the tour again
    </button>
  );
}
