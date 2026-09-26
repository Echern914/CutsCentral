import { NextResponse, type NextRequest } from "next/server";
import { apiPublicGet } from "@/lib/api";
import { DOMAIN_PARAM, PATH_PARAM, normalizeDomain } from "@/lib/customDomainGuard";

/**
 * Custom-domain resolver. The middleware rewrites every request on a foreign
 * host here; this route looks the domain up and issues the REDIRECT that is
 * the whole design: 308 to the shop's canonical getchairback.com URL. Google
 * follows the 308, indexes the ChairBack URL, and shows it in results - the
 * barber's domain is a pointer, on purpose.
 *
 * Three answers, and they must never be confused:
 *
 *   FOUND       -> 308 to the shop, carrying the visitor's own query (an
 *                  Instagram bio link arrives with utm_* and fbclid, and they
 *                  are the only record of where the visit came from) plus
 *                  `cb_domain`, so the page it lands on can refuse to show any
 *                  shop but this domain's (lib/customDomainGuard.ts).
 *   NOT FOUND   -> 302 to the marketing home. Unknown, unverified or
 *                  disconnected: nothing of anyone's is served under the name.
 *                  Temporary, because a domain mid-setup starts working the
 *                  moment its owner's DNS is proven.
 *   UNAVAILABLE -> 🔴 a retry page ON THE DOMAIN, 503, never cached. The lookup
 *                  failed (network, timeout, rate limit, 5xx) - which says
 *                  nothing about the domain. This used to 302 to the marketing
 *                  home, so a customer who tapped a barber's link during an API
 *                  redeploy landed on ChairBack's sales page with no way back
 *                  and nothing telling anyone it had happened.
 *
 * 🔴 THE LOOKUP IS NOT CACHED. It used to be, for 5 minutes, so a shop that
 * renamed its slug kept sending its domain to the OLD name - which another shop
 * may already hold. A fresh answer closes that window for everything but the
 * moment between this lookup and the browser following the redirect, and the
 * landing page's own domain check closes that. Uncached calls forward the
 * visitor's IP, so the API rate-limits each visitor on their own.
 */

const CANONICAL_ORIGIN = "https://getchairback.com";

/** Our own redirects are never cached: the answer is live, and so is the slug. */
const NO_STORE = "private, no-store";

/** The visitor's own query, minus our internal path carrier. */
function visitorQuery(params: URLSearchParams): URLSearchParams {
  const q = new URLSearchParams(params);
  q.delete(PATH_PARAM);
  return q;
}

function withQuery(base: string, q: URLSearchParams): string {
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

function redirect(to: string, status: 302 | 308): NextResponse {
  const res = NextResponse.redirect(to, status);
  res.headers.set("Cache-Control", NO_STORE);
  return res;
}

/**
 * The original path on the custom domain, as the middleware carried it. Only
 * ever a local path: anything else (a protocol-relative `//elsewhere`, a
 * backslash trick, a scheme) becomes "/", so the retry link can only ever
 * point back at this same domain.
 */
function originalPath(params: URLSearchParams): string {
  const p = params.get(PATH_PARAM) ?? "/";
  if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\") || /[\u0000-\u001f]/.test(p)) {
    return "/";
  }
  return p;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * What a customer sees when the lookup could not answer. On the domain they
 * tapped, in plain words, with one way forward: the same link again, query
 * and all. No shop is named - which shop this domain belongs to is exactly
 * what we could not find out.
 */
function retryPage(host: string, retryHref: string): NextResponse {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Just a moment</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #111; color: #f5f2ea; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 22rem; padding: 2rem 1.5rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1.5rem; color: #b9b3a7; }
  a { display: inline-block; padding: .75rem 1.5rem; border-radius: .75rem; background: #c9a24a; color: #111;
      font-weight: 600; text-decoration: none; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(host)} is taking a moment to load</h1>
  <p>This is usually brief. Please try again in a few seconds.</p>
  <a href="${escapeHtml(retryHref)}">Try again</a>
</main>
</body>
</html>`;
  return new NextResponse(html, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": NO_STORE,
      "Retry-After": "5",
      "X-Robots-Tag": "noindex",
    },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: { host: string } },
) {
  const incoming = req.nextUrl.searchParams;
  const query = visitorQuery(incoming);
  const host = normalizeDomain(params.host);
  if (!host) return redirect(withQuery(CANONICAL_ORIGIN, query), 302);

  // Uncached: see the note at the top.
  const res = await apiPublicGet<{ slug: string }>(
    `/api/page/-/by-domain/${encodeURIComponent(host)}`,
  );

  if (res.ok && res.data?.slug) {
    const slug = encodeURIComponent(res.data.slug);
    // Their /book goes to booking; everything else lands on the shop page.
    const target = originalPath(incoming).startsWith("/book")
      ? `${CANONICAL_ORIGIN}/book/${slug}`
      : `${CANONICAL_ORIGIN}/s/${slug}`;
    query.set(DOMAIN_PARAM, host);
    return redirect(withQuery(target, query), 308);
  }

  // A definite "no such domain" from the API. Anything else is not an answer.
  if (res.status === 404 || res.status === 400) {
    return redirect(withQuery(CANONICAL_ORIGIN, query), 302);
  }

  // Not silent: the host and the status, never anything about a visitor.
  console.error(
    JSON.stringify({
      event: "custom_domain_lookup_unavailable",
      host,
      status: res.status,
      error: res.error ?? (res.ok ? "no_slug_in_answer" : null),
    }),
  );
  return retryPage(host, withQuery(originalPath(incoming), query));
}
