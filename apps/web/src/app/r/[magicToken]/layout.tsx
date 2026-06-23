import { pageFontVars } from "@/lib/pageFonts";

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
