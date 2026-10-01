import * as React from "react";
import { apiPublicGet } from "@/lib/api";
import { classifyDomainLookup, type DomainLookup } from "@/lib/customDomainGuard";

type Lookup = (domain: string) => Promise<DomainLookup>;

/**
 * React's per-request memo: present in the React that Next runs server
 * components on, absent from the stable React the unit tests run - and from
 * this repo's React types, which is why it is read off the namespace rather
 * than imported by name.
 */
const reactCache = (React as unknown as { cache?: (fn: Lookup) => Lookup }).cache;

/**
 * Which shop a custom domain belongs to - the ONLY way a page served on a
 * shop's own domain learns which shop it is. `domain` is already normalized
 * (customDomainGuard normalizeDomain).
 *
 * 🔴 NOT CACHED. A cached domain -> slug answer outlives a slug: a shop that
 * renames keeps sending its domain to the OLD name, which another shop may
 * already hold. Uncached calls forward the visitor's IP, so the API
 * rate-limits each visitor on their own rather than every visitor at once.
 *
 * One answer per request: the page and its metadata both ask, and they must
 * agree - a lookup that failed for one and not the other would title a shop's
 * page "Just a moment". A plain call where React has no `cache`.
 */
const lookup: Lookup = async (domain) =>
  classifyDomainLookup(
    await apiPublicGet<{ slug: string }>(`/api/page/-/by-domain/${encodeURIComponent(domain)}`),
  );

export const lookupCustomDomain: Lookup = typeof reactCache === "function" ? reactCache(lookup) : lookup;
