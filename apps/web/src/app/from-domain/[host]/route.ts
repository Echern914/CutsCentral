import { NextResponse, type NextRequest } from "next/server";
import { apiPublicGet } from "@/lib/api";

/**
 * Custom-domain resolver. The middleware rewrites every request on a foreign
 * host here; this route looks the domain up and issues the REDIRECT that is
 * the whole design: 308 to the shop's canonical getchairback.com URL. Google
 * follows the 308, indexes the ChairBack URL, and shows it in results - the
 * barber's domain is a pointer, on purpose.
 *
 * 308 (not 307) because the redirect is permanent and 308 preserves method;
 * an unknown domain gets a 302 to the marketing home instead - "temporary" is
 * the truthful signal there, since the shop may be mid-DNS-setup and the
 * domain will start resolving properly within the hour.
 */

const CANONICAL_ORIGIN = "https://getchairback.com";
/** by-domain answers are cached this long - a just-connected domain starts
 * redirecting within 5 minutes without any cache purge machinery. */
const RESOLVE_REVALIDATE_S = 300;

export async function GET(
  req: NextRequest,
  { params }: { params: { host: string } },
) {
  // Same normalize + shape check the API applies; garbage never leaves here.
  const host = params.host.toLowerCase().replace(/^www\./, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) {
    return NextResponse.redirect(CANONICAL_ORIGIN, 302);
  }

  const res = await apiPublicGet<{ slug: string }>(
    `/api/page/-/by-domain/${encodeURIComponent(host)}`,
    RESOLVE_REVALIDATE_S,
  );
  if (!res.ok || !res.data?.slug) {
    return NextResponse.redirect(CANONICAL_ORIGIN, 302);
  }

  const slug = encodeURIComponent(res.data.slug);
  // Original path on the custom domain, carried by the middleware. Their
  // /book goes to booking; everything else lands on the shop page.
  const originalPath = req.nextUrl.searchParams.get("p") ?? "/";
  const target = originalPath.startsWith("/book")
    ? `${CANONICAL_ORIGIN}/book/${slug}`
    : `${CANONICAL_ORIGIN}/s/${slug}`;
  return NextResponse.redirect(target, 308);
}
