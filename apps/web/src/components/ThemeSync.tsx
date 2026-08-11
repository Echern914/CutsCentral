"use client";

import { useEffect } from "react";
import { applyTheme, type Theme } from "@/lib/theme";

/**
 * One-shot sync of the API's stored theme onto the document. Rendered by the
 * dashboard layout (which fetches /me anyway), so a barber's choice follows
 * their ACCOUNT to a fresh browser - localStorage alone would leave a new
 * device dark until they toggled again. Runs after ThemeScope's route effect
 * (deeper in the tree), so the server truth wins the mount race; both write
 * the same localStorage key, so they agree from then on.
 */
export function ThemeSync({ theme }: { theme: Theme }) {
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  return null;
}
