import type { Viewport } from "next";
import { pageFontVars } from "@/lib/pageFonts";

/**
 * Lock zoom on the rewards page so it feels like an app, not a zoomable web page
 * - both inside the native WebView (which also injects this) and for customers
 * who open the SMS link in mobile Safari. Scoped to /r/* only (this layout), so
 * the marketing site + dashboard stay pinch-zoomable for accessibility.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0A0A0B",
};

/**
 * Client rewards page font loader. Declares the curated PAGE_FONTS families as
 * CSS variables (shared with the public /s mini-site and the dashboard preview
 * via pageFontVars) so a client's rewards page renders in the shop's chosen
 * typography - part of carrying the barber's full identity onto this page.
 * next/font self-hosts these (no external request, CSP-safe).
 */
export default function RewardsLayout({ children }: { children: React.ReactNode }) {
  return <div className={pageFontVars}>{children}</div>;
}
