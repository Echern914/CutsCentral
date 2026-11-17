import type { Viewport } from "next";
import { apiPublicGet } from "@/lib/api";
import { keepTokenPageOnDomain, visitDomain, visitPathUnder } from "@/lib/customDomainVisit";
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
export default async function RewardsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { magicToken: string };
}) {
  await keepCardOnItsDomain(params.magicToken);
  return <div className={pageFontVars}>{children}</div>;
}

/** The pages' own REWARDS_REVALIDATE_S: the same call, so Next makes it once. */
const CARD_REVALIDATE_S = 10;

/**
 * 🔴 ON A SHOP'S DOMAIN, ANOTHER SHOP'S CARD IS A REAL 307 - FROM HERE.
 *
 * Both pages under this layout make the same check (page.tsx and
 * rewards/page.tsx, body and generateMetadata), but this segment has a
 * loading.tsx, so they STREAM: by the time either redirects, a 200 has gone
 * out and the redirect can only be a refresh inside it. A layout renders
 * OUTSIDE its own segment's loading boundary, before anything is sent, so a
 * redirect from here is a real one. Found end to end with curl - a unit test
 * that calls a page sees its redirect either way.
 *
 * Only on a shop's domain; on getchairback.com nothing is read. The card is
 * read with the very call the pages make (same path, same revalidate), which
 * Next memoises per request, so this adds no API call. A token that does not
 * read is left to the page, which answers it as it always has.
 */
async function keepCardOnItsDomain(magicToken: string): Promise<void> {
  if (visitDomain() === null) return;
  const res = await apiPublicGet<{ shop: { pageSlug: string | null } }>(
    `/api/rewards/${magicToken}`,
    CARD_REVALIDATE_S,
  );
  const card = res.ok ? res.data : null;
  if (!card) return;
  await keepTokenPageOnDomain(card.shop.pageSlug, visitPathUnder(`/r/${magicToken}`));
}
