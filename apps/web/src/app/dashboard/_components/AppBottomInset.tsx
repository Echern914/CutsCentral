"use client";

import { useLayoutEffect } from "react";
import { applyAppBottomInset } from "@/lib/appSafeArea";

/**
 * Re-runs the home-indicator detection (lib/appSafeArea.ts) once the dashboard
 * is mounted. The layout's inline script covers a full page load; this covers
 * arriving here by a client-side navigation, where React never runs inline
 * scripts. Idempotent, so running after the script is harmless.
 */
export function AppBottomInset() {
  useLayoutEffect(() => {
    try {
      applyAppBottomInset(window);
    } catch {
      /* no inset beats a crashed dashboard */
    }
  }, []);
  return null;
}
