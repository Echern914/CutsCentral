import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { lookupCustomDomain } from "@/lib/customDomain";
import {
  expectedDomain,
  isPlatformHost,
  normalizeDomain,
  reportLookupUnavailable,
  servesDomain,
} from "@/lib/customDomainGuard";
import { PLATFORM_ORIGIN, VISIT_PATH_HEADER } from "@/lib/customDomainRouting";

/**
 * Which shop's domain THIS request is on - for the pages a shop's domain
 * serves at their own path (lib/customDomainRouting.ts), which must refuse to
 * show any other shop there.
 *
 * Server-only: it reads the request's Host. Reading it also makes the page
 * render per request, which these pages must: one rendered for drickcuttinup.com
 * must never be handed, from a cache, to a visitor on getchairback.com.
 */

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The shop domain this request came in on: null on ChairBack's own hosts,
 * "invalid" for a Host that is not a hostname (the middleware never serves
 * one, so only a direct hit gets here, and it is nobody's domain).
 *
 * Null too outside a request (a unit test calling a page): that is the
 * platform, exactly as these pages behaved before they were served on a
 * shop's domain.
 */
export function visitDomain(): string | "invalid" | null {
  let host: string;
  try {
    host = headers().get("host") ?? "";
  } catch {
    return null;
  }
  if (!host || isPlatformHost(host)) return null;
  return normalizeDomain(host) ?? "invalid";
}

/**
 * The domain a page must prove its shop owns: the one the visit is ON, else
 * the `cb_domain` a link from the redirect days still carries
 * (lib/customDomainGuard.ts). Null for an ordinary platform visit.
 */
export function expectedDomainForVisit(searchParams?: SearchParams): string | "invalid" | null {
  return visitDomain() ?? expectedDomain(searchParams);
}

/** May this shop's page be shown on THIS request's host? Always, on the platform. */
export function servesThisVisit(data: { customDomain?: string | null } | null): boolean {
  const domain = visitDomain();
  return domain === null ? Boolean(data) : servesDomain(data, domain);
}

/** A path with the visitor's own query, as it arrived. */
export function withVisitorQuery(path: string, searchParams?: SearchParams): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) q.append(key, v);
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/**
 * The path and query this visit asked for, as the middleware recorded it
 * (VISIT_PATH_HEADER) - for a layout, which is told neither. Taken only when
 * it is `page` itself or a page under it, so a header that names anything
 * else can never steer a redirect; `page` otherwise, and outside a request.
 */
export function visitPathUnder(page: string): string {
  let raw: string | null;
  try {
    raw = headers().get(VISIT_PATH_HEADER);
  } catch {
    return page;
  }
  if (!raw || !raw.startsWith(page)) return page;
  const next = raw.charAt(page.length);
  return next === "" || next === "/" || next === "?" ? raw : page;
}

/**
 * For a page a TOKEN opens (a booking, a party, a client's card): on a shop's
 * domain it is shown only when the token's shop is the one that owns the
 * domain. Anything else - another shop's token, a shop with no public page, a
 * lookup that could not answer - goes to the same page on getchairback.com,
 * where the token always works. So the customer always reaches their page,
 * and a shop's domain never shows another shop's.
 *
 * Returns on the platform and for the owner's own token; redirects otherwise.
 * `platformPath` is the page's own path and query.
 */
export async function keepTokenPageOnDomain(
  shopSlug: string | null | undefined,
  platformPath: string,
): Promise<void> {
  const domain = visitDomain();
  if (domain === null) return;
  if (domain !== "invalid" && shopSlug) {
    const lookup = await lookupCustomDomain(domain);
    if (lookup.kind === "found" && lookup.slug === shopSlug) return;
    if (lookup.kind === "unavailable") reportLookupUnavailable(domain, lookup);
  }
  redirect(`${PLATFORM_ORIGIN}${platformPath}`);
}
