import type { MetadataRoute } from "next";

/**
 * Static marketing pages only. Shop mini-sites (/s/[slug]) are deliberately
 * excluded for now: enumerating them needs a DB read at build/request time,
 * and shops control their own discoverability via publicPageEnabled.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://getchairback.com";
  const pages = [
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
  return pages.map((p) => ({
    url: `${base}${p}`,
    changeFrequency: p === "" ? "weekly" : "monthly",
    priority: p === "" ? 1 : 0.6,
  }));
}
