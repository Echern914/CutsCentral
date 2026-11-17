import type { ReactElement } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { lookupCustomDomain } from "@/lib/customDomain";
import { normalizeDomain, reportLookupUnavailable } from "@/lib/customDomainGuard";
import { PLATFORM_ORIGIN } from "@/lib/customDomainRouting";
import { withVisitorQuery } from "@/lib/customDomainVisit";
import { DomainRetry } from "./DomainRetry";

/**
 * WHOSE DOMAIN IS THIS - the one question every page served on a shop's own
 * domain (this folder) asks first, answered the same way for all of them.
 * The host is the only input; no slug from the URL is ever read
 * (lib/customDomainRouting.ts).
 *
 * Three answers from the lookup, and they must never be confused:
 *
 *   FOUND       -> that slug. The page then renders it only if the shop OWNS
 *                  this verified domain (the page's own check): a slug can
 *                  change hands between the lookup and the read.
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

export type SearchParams = Record<string, string | string[] | undefined>;

export interface DomainShopProps {
  params: { host: string };
  searchParams?: SearchParams;
}

/**
 * The shop to render on this domain, or the page to show instead (the retry
 * page). Not found, or not a hostname, redirects and never returns.
 * `ownPath` is the page's address on the domain ("/" or "/book"), for the
 * retry link - which is relative, so it cannot leave the domain.
 */
export async function domainShop(
  { params, searchParams }: DomainShopProps,
  ownPath: string,
): Promise<{ kind: "found"; slug: string; domain: string } | { kind: "retry"; page: ReactElement }> {
  // The middleware only ever sends a valid host here; anything else is nobody's.
  const domain = normalizeDomain(params.host);
  if (!domain) redirect(`${PLATFORM_ORIGIN}/`);

  const lookup = await lookupCustomDomain(domain);
  if (lookup.kind === "none") redirect(withVisitorQuery(`${PLATFORM_ORIGIN}/`, searchParams));
  if (lookup.kind === "unavailable") {
    reportLookupUnavailable(domain, lookup);
    return {
      kind: "retry",
      page: <DomainRetry domain={domain} retryHref={withVisitorQuery(ownPath, searchParams)} />,
    };
  }
  return { kind: "found", slug: lookup.slug, domain };
}

/**
 * The metadata of a page served on this domain: nothing of any shop's until
 * the lookup has named it - not even a name in a tab.
 */
export async function domainShopMetadata(
  { params }: DomainShopProps,
  forShop: (slug: string, domain: string) => Promise<Metadata>,
): Promise<Metadata> {
  const domain = normalizeDomain(params.host);
  if (!domain) return {};
  const lookup = await lookupCustomDomain(domain);
  if (lookup.kind === "unavailable") return { title: "Just a moment", robots: { index: false } };
  if (lookup.kind === "none") return {};
  return forShop(lookup.slug, domain);
}
