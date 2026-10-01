import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { lookupCustomDomain } from "@/lib/customDomain";
import { DOMAIN_PARAM, normalizeDomain, reportLookupUnavailable } from "@/lib/customDomainGuard";
import { PLATFORM_ORIGIN } from "@/lib/customDomainRouting";
import ShopPageLayout from "@/app/s/[slug]/layout";
import { loadShopPage, shopPageMetadata, shopPageTree } from "@/app/s/[slug]/shopPage";
import { DomainRetry } from "./DomainRetry";

/**
 * A shop's page, served on the shop's OWN domain: the middleware rewrites the
 * bare domain (and /s/...) here, with the host as the only input. A customer
 * who taps the domain in an Instagram bio stays on it - no hop off to
 * getchairback.com, which is where the old redirect sent them.
 *
 * It is the same page as /s/[slug] (s/[slug]/shopPage.tsx), and its canonical
 * link names the getchairback.com address, so search keeps indexing the one
 * URL it always has. Its links to booking go to getchairback.com - see
 * lib/customDomainRouting.ts for why booking stays there.
 *
 * Three answers from the lookup, and they must never be confused:
 *
 *   FOUND       -> the shop's page, and only if that shop OWNS this verified
 *                  domain (loadShopPage): a slug can change hands between the
 *                  lookup and the read. Otherwise a plain not-found.
 *   NOT FOUND   -> the ChairBack home page, temporarily, the visitor's query
 *                  kept. Unknown, unverified or disconnected: nothing of
 *                  anyone's is served under the name. Temporary, because a
 *                  domain mid-setup starts working the moment its owner's DNS
 *                  is proven.
 *   UNAVAILABLE -> 🔴 a retry page ON the domain. The lookup failed, which
 *                  says nothing about the domain - sending the customer to
 *                  ChairBack's home page would strand them there with no way
 *                  back, and nobody would know it had happened.
 */

// Never cached, whatever the answer: the lookup is live, a slug can move, and
// a retry page must not outlive the moment it describes.
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

interface Props {
  params: { host: string };
  searchParams?: SearchParams;
}

/**
 * The visitor's own query as it arrived - utm_*, fbclid, a ?service= - for the
 * links this page builds back to itself or on to the platform.
 */
function visitorQuery(searchParams?: SearchParams): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) q.append(key, v);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const domain = normalizeDomain(params.host);
  if (!domain) return {};
  const lookup = await lookupCustomDomain(domain);
  if (lookup.kind === "unavailable") return { title: "Just a moment", robots: { index: false } };
  if (lookup.kind === "none") return {};
  return shopPageMetadata(await loadShopPage(lookup.slug, domain));
}

export default async function CustomDomainShopPage({ params, searchParams }: Props) {
  // The middleware only ever sends a valid host here; anything else is nobody's.
  const domain = normalizeDomain(params.host);
  if (!domain) redirect(`${PLATFORM_ORIGIN}/`);

  const lookup = await lookupCustomDomain(domain);
  if (lookup.kind === "none") redirect(`${PLATFORM_ORIGIN}/${visitorQuery(searchParams)}`);
  if (lookup.kind === "unavailable") {
    reportLookupUnavailable(domain, lookup);
    // Every path served here is this same page, so "/" with the query is the
    // same link again - and a relative link cannot leave the domain.
    return <DomainRetry domain={domain} retryHref={`/${visitorQuery(searchParams)}`} />;
  }

  const data = await loadShopPage(lookup.slug, domain);
  if (!data) notFound();
  return (
    <ShopPageLayout>
      {shopPageTree(data, {
        // Booking on the platform makes the same ownership check this page just did.
        bookQuery: `?${DOMAIN_PARAM}=${encodeURIComponent(domain)}`,
        platformOrigin: PLATFORM_ORIGIN,
      })}
    </ShopPageLayout>
  );
}
