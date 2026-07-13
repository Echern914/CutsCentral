"use client";

import { useEffect, useState } from "react";
import { DEMO_TOUR_STEPS } from "@chairback/config/demoTour";

/**
 * Shared demo-tour state: the current 1-based step number, persisted in
 * sessionStorage so it survives the tour's cross-page navigations, mirrored
 * through a window event so the overlay (DemoTour) and the host pages (e.g.
 * BookingClient's demo intercepts) stay in sync within a page.
 */
const KEY = "cb_demo_tour";
const EVENT = "cb-demo-tour-step";

export function readTourStep(): number | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(KEY);
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= DEMO_TOUR_STEPS.length ? n : null;
}

/** Set the current step (null = end the tour) and notify subscribers. */
export function writeTourStep(step: number | null): void {
  if (typeof window === "undefined") return;
  if (step === null) window.sessionStorage.removeItem(KEY);
  else window.sessionStorage.setItem(KEY, String(step));
  window.dispatchEvent(new CustomEvent(EVENT));
}

/**
 * The live tour position for host pages: `step` (1-based) and the config id of
 * that step, both null when no tour is running. Reads as inactive during SSR
 * and the first client render (state only exists in sessionStorage), so pages
 * hydrate identically with or without a tour.
 */
export function useDemoTour(): { step: number | null; stepId: string | null } {
  const [step, setStep] = useState<number | null>(null);
  useEffect(() => {
    const sync = () => setStep(readTourStep());
    sync();
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  return { step, stepId: step === null ? null : (DEMO_TOUR_STEPS[step - 1]?.id ?? null) };
}
