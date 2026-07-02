import type { MetadataRoute } from "next";

/**
 * Crawl policy: index the marketing surface, keep every private/tokenized
 * surface out. /r/ (magic-token rewards) and /book/manage/ (manage tokens)
 * must never be indexed - a crawled link there is an auth credential.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/dashboard", "/admin", "/r/", "/book/manage/", "/onboarding", "/welcome"],
      },
    ],
    sitemap: "https://getchairback.com/sitemap.xml",
  };
}
