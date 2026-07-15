import type { Viewport } from "next";
import { pageFontVars } from "@/lib/pageFonts";

/**
 * Rewards page viewport. We deliberately do NOT lock zoom: blocking pinch-zoom
 * (maximumScale:1 / userScalable:false) fails WCAG 1.4.4 (Resize Text) for
 * low-vision customers opening the SMS link in mobile Safari. The native WebView
 * still handles its own "app-like" feel, so keeping the web path zoomable costs
 * us nothing there. viewportFit:cover is retained for edge-to-edge notch layout.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
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
