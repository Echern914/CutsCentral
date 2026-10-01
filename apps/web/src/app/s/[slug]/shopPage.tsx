import type { Metadata } from "next";
import { APP_NAME, serviceNounForShop } from "@chairback/config/constants";
import { apiPublicGet } from "@/lib/api";
import { servesDomain } from "@/lib/customDomainGuard";
import { PLATFORM_ORIGIN } from "@/lib/customDomainRouting";
import { GetTheApp } from "@/components/GetTheApp";
import { ShopPageClient } from "./ShopPageClient";
import { shopJsonLd } from "./shopJsonLd";
import type { ShopPageData } from "./page";

/**
 * The shop's page, for both places it is served: getchairback.com/s/<slug>
 * (page.tsx) and the shop's own domain (app/custom-domain/[host]). One reader,
 * one metadata, one tree - so the two addresses can never show different
 * pages, or check ownership differently.
 */

// Cache the public shop-page data (theme, bio, reviews, promotions) for 60s.
// This does two things: the metadata + render calls to the SAME endpoint dedupe
// into one upstream request, and repeat visitors within the window get a cached
// response instead of a ~1s API+DB round trip. A barber's edit appears within
// 60s. (The live booking-slots feed on /book is deliberately NOT cached.)
const SHOP_PAGE_REVALIDATE_S = 60;

async function getData(slug: string, fresh = false): Promise<ShopPageData | null> {
  const res = await apiPublicGet<ShopPageData>(
    `/api/page/${encodeURIComponent(slug)}`,
    fresh ? undefined : SHOP_PAGE_REVALIDATE_S,
  );
  return res.ok ? res.data : null;
}

/**
 * The page for THIS visit, or null when it must not render.
 *
 * `expected` is the custom domain the visit came through (null for an
 * ordinary visit; "invalid" for a tampered marker). 🔴 A visit through a
 * custom domain renders only the shop that owns that domain: the domain was
 * looked up to this slug a moment ago, and by now the slug may belong to
 * someone else. Then this fails closed - a plain not-found, never the other
 * shop. A mismatch is re-read once, uncached, before refusing: the cached copy
 * can predate the domain being verified, and that must not turn away the
 * shop's own visitors.
 */
export async function loadShopPage(
  slug: string,
  expected: string | "invalid" | null,
): Promise<ShopPageData | null> {
  const data = await getData(slug);
  if (expected === null || servesDomain(data, expected)) return data;
  const fresh = await getData(slug, true);
  return servesDomain(fresh, expected) ? fresh : null;
}

/**
 * The page's metadata. Refused or missing: nothing of any shop's - not even
 * its name in a tab.
 */
export function shopPageMetadata(data: ShopPageData | null): Metadata {
  if (!data) return { title: APP_NAME, robots: { index: false } };
  const description =
    data.bio ??
    `Book your next ${serviceNounForShop(data)} at ${data.name} and earn rewards every visit.`;
  return {
    title: data.name,
    description,
    // The page's one address for search, wherever it is served from: the copy
    // on a shop's own domain must not become a second URL competing with it.
    alternates: { canonical: `${PLATFORM_ORIGIN}/s/${encodeURIComponent(data.slug)}` },
    openGraph: {
      title: data.name,
      description,
      type: "website",
      ...(data.heroImageUrl ? { images: [{ url: data.heroImageUrl }] } : {}),
    },
    twitter: { card: "summary_large_image", title: data.name, description },
  };
}

/**
 * The page itself. `bookQuery` carries the same-shop check on to booking for
 * a visit through a custom domain; `platformOrigin` is set when the page is
 * served ON that domain, so its links to ChairBack itself - booking above all
 * - point at getchairback.com and not at the shop's domain.
 *
 * A function returning the tree, not a component: the pages hand back exactly
 * this element tree.
 */
export function shopPageTree(
  data: ShopPageData,
  links: { bookQuery?: string; platformOrigin?: string } = {},
): React.ReactElement {
  return (
    <>
      {/* JSON.stringify output is safe inside a script tag except for a
          literal "</script>" in a string field - the < escape closes that
          hole. Standard Next.js JSON-LD pattern. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(shopJsonLd(data)).replace(/</g, "\\u003c"),
        }}
      />
      <ShopPageClient data={data} bookQuery={links.bookQuery} platformOrigin={links.platformOrigin} />
      <div className="mx-auto w-full max-w-2xl px-4 pb-8">
        <GetTheApp surface="shop" />
      </div>
    </>
  );
}
