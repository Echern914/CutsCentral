"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { applyTheme, storedTheme, suspendTheme, themeableRoute, type Theme } from "@/lib/theme";

/**
 * Keeps the data-theme attribute scoped to the routes that honor the personal
 * theme (see lib/theme.ts). Mounted once in the ROOT layout so SPA navigation
 * between a light dashboard and a brand-dark public page flips the attribute
 * both ways - without this, a barber who opened their own booking page from
 * the dashboard would see it in their personal theme, which is NOT what their
 * clients see.
 *
 * `serverTheme` rides in from layouts that know the API's answer (dashboard
 * fetches /me anyway): it wins over localStorage so a barber's choice follows
 * them to a fresh browser, then localStorage echoes it for next time.
 */
export function ThemeScope({ serverTheme }: { serverTheme?: Theme }) {
  const pathname = usePathname();
  useEffect(() => {
    if (themeableRoute(pathname)) applyTheme(serverTheme ?? storedTheme());
    else suspendTheme();
  }, [pathname, serverTheme]);
  return null;
}
