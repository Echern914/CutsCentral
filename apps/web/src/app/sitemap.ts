import type { MetadataRoute } from "next";
import { apiPublicGet } from "@/lib/api";

/**
 * Static marketing pages + every live shop mini-site.
 *
 * Shop pages were originally excluded; that made them UNDISCOVERABLE - no
 * crawlable page links /s/[slug], so a shop a customer googles by name might
 * simply never be indexed. Since the custom-domain feature's whole promise is
 * "search the shop, find its ChairBack page", the sitemap is where that
 * promise is actually kept. Shops opt out the same way they always could:
 * turning the public page off removes them from /api/page/-/sitemap.
 *
 * The shop list is fetched with a 1h revalidate; if the API is unreachable at
 * build/revalidate time we still emit the static pages (never a hard failure).
 */
export const revalidate = 3600;

const BASE = "https://getchairback.com";

const STATIC_PAGES = [
  "",
  "/pricing",
  "/signup",
  "/login",
  "/terms",
  "/privacy",
  "/sms",
  "/support",
  "/for/barbers",
  "/for/salons",
  "/for/nails",
  "/for/lashes",
  "/for/spas",
  "/for/tattoo",
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = STATIC_PAGES.map((p) => ({
    url: `${BASE}${p}`,
    changeFrequency: p === "" ? "weekly" : "monthly",
    priority: p === "" ? 1 : 0.6,
  }));

  const res = await apiPublicGet<{ shops: { slug: string; updatedAt: string }[] }>(
    "/api/page/-/sitemap",
    revalidate,
  );
  const shopEntries: MetadataRoute.Sitemap = (res.ok ? res.data?.shops ?? [] : []).map(
    (s) => ({
      url: `${BASE}/s/${encodeURIComponent(s.slug)}`,
      lastModified: s.updatedAt,
      changeFrequency: "weekly",
      priority: 0.7,
    }),
  );

  return [...staticEntries, ...shopEntries];
}
