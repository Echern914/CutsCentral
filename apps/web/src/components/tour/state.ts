"use client";

import { useEffect, useState } from "react";
import { TOURS, type TourId } from "./tourPaths";

/**
 * Shared demo-tour state: the current 1-based step number per tour, persisted
 * in sessionStorage (each tour has its own key) so it survives cross-page
 * navigations, mirrored through a window event so the overlay (DemoTour) and
 * the host pages (e.g. BookingClient's demo intercepts, BookingManager's tab
 * auto-drive) stay in sync within a page.
 */
const EVENT = "cb-demo-tour-step";

export function readTourStep(tour: TourId): number | null {
  if (typeof window === "undefined") return null;
  const spec = TOURS[tour];
  const raw = window.sessionStorage.getItem(spec.storageKey);
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= spec.steps.length ? n : null;
}

/** Set the current step of a tour (null = end it) and notify subscribers. */
export function writeTourStep(tour: TourId, step: number | null): void {
  if (typeof window === "undefined") return;
  const spec = TOURS[tour];
  if (step === null) window.sessionStorage.removeItem(spec.storageKey);
  else window.sessionStorage.setItem(spec.storageKey, String(step));
  window.dispatchEvent(new CustomEvent(EVENT));
}

/**
 * The live position of a tour for host pages: `step` (1-based) and the config
 * id of that step, both null when the tour isn't running. Reads as inactive
 * during SSR and the first client render (state only exists in
 * sessionStorage), so pages hydrate identically with or without a tour.
 */
export function useDemoTour(tour: TourId = "client"): {
  step: number | null;
  stepId: string | null;
} {
  const [step, setStep] = useState<number | null>(null);
  useEffect(() => {
    const sync = () => setStep(readTourStep(tour));
    sync();
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, [tour]);
  return {
    step,
    stepId: step === null ? null : (TOURS[tour].steps[step - 1]?.id ?? null),
  };
}
