import { apiPublicGet } from "@/lib/api";
import { customDomainKey, normalizeHost } from "@/lib/customDomainRouting";

/**
 * by-domain answers are cached this long. A just-verified domain starts
 * serving within 5 minutes, and a disconnected one stops within 5, with no
 * purge machinery. It is also what keeps the lookup off the public API's
 * per-IP rate limit: every visitor shares this cached answer.
 */
const RESOLVE_REVALIDATE_S = 300;

/**
 * The slug of the shop a custom domain belongs to - the ONLY way a page on a
 * shop's own domain learns which shop it is.
 *
 * Null for anything that must not render a shop: a malformed host, a domain
 * nobody has connected, one whose owner has not yet proven ownership (the
 * TXT record), a shop whose public page is switched off, or an API that could
 * not answer. The API applies the verified gate; this never guesses around it.
 */
export async function resolveCustomDomain(rawHost: string): Promise<string | null> {
  const host = normalizeHost(rawHost);
  if (!host) return null;
  const res = await apiPublicGet<{ slug: string }>(
    `/api/page/-/by-domain/${encodeURIComponent(customDomainKey(host))}`,
    RESOLVE_REVALIDATE_S,
  );
  return res.ok && res.data?.slug ? res.data.slug : null;
}
