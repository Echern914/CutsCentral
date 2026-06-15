import { pageFontVars } from "@/lib/pageFonts";

/**
 * Public shop page font loader. Loads the curated PAGE_FONTS families (shared
 * with the dashboard live preview via pageFontVars) and exposes them as CSS
 * variables on a wrapper. The page picks which variable to use from the shop's
 * fontKey, so a shop's typography is part of its identity. next/font self-hosts
 * these (no external request, CSP-safe).
 */
export default function ShopPageLayout({ children }: { children: React.ReactNode }) {
  return <div className={pageFontVars}>{children}</div>;
}
