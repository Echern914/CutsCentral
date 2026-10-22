"use client";

import { useEffect } from "react";
import { APP_SCHEME_ATTR, PAGE_SCHEME_ATTR, tellAppScheme, wearPageDark } from "@/lib/theme";

/**
 * Marks a public page as wearing its SHOP'S dark scheme (lib/theme.ts).
 *
 * The server renders this with the pre-paint script beside it, so a hard load
 * is dark from the first frame. On an in-app navigation the script does not
 * run, so this sets the attribute itself; ThemeScope, which runs after it in
 * the same commit, sees the marker and leaves the dark in place.
 *
 * No cleanup on purpose. Leaving the page changes the route, and ThemeScope
 * re-decides after React has already removed this marker from the DOM - so it
 * lands on light, or on the barber's own theme in the dashboard. A cleanup
 * here would run AFTER that and could wipe a barber's personal dark theme.
 */
export function PageScheme({ scheme }: { scheme: "light" | "dark" }) {
  useEffect(() => {
    if (scheme === "dark") wearPageDark();
  }, [scheme]);
  return <span hidden {...{ [PAGE_SCHEME_ATTR]: scheme }} />;
}

/**
 * Tells the iPhone app which scheme a page with its OWN colours shows - a
 * shop's storefront or a client's rewards page - so the app's bar above it
 * (the one with "Done") matches instead of sitting cream over a black page
 * (Eric, 2026-10-22: "white slab on top doesn't look professional").
 *
 * Unlike PageScheme it changes nothing on the page: ChairBack's tokens stay
 * as they are. Said on mount, and again by ThemeScope on every route change,
 * which reads this marker.
 */
export function AppFrameScheme({ scheme }: { scheme: "light" | "dark" }) {
  useEffect(() => {
    tellAppScheme(scheme);
  }, [scheme]);
  return <span hidden {...{ [APP_SCHEME_ATTR]: scheme }} />;
}
