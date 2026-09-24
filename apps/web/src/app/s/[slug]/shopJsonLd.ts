import { businessType } from "@chairback/config/businessTypes";
import type { ShopPageData } from "./page";

/**
 * LocalBusiness structured data - the piece that makes the shop's ChairBack
 * page read as a BUSINESS to Google (name + address + rating rich results,
 * local-pack eligibility), not just a web page. Address is included only when
 * street + city are both set; aggregateRating only with 1+ approved reviews
 * (Google flags a rating block with zero reviews as spammy markup).
 *
 * Its own module (not inside page.tsx) so it can be tested: a Next.js page file
 * may only export the names Next.js knows about.
 */
export function shopJsonLd(data: ShopPageData): Record<string, unknown> {
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    // From the registry, so a new vertical cannot silently fall back to a
    // generic LocalBusiness and lose its rich-result eligibility - the old
    // `Record<string,string>` + `?? "LocalBusiness"` degraded with nothing
    // failing anywhere.
    "@type": businessType(data.industry).schemaType,
    name: data.name,
    url: `https://getchairback.com/s/${encodeURIComponent(data.slug)}`,
    ...(data.bio ? { description: data.bio } : {}),
    ...(data.logoUrl ? { image: data.logoUrl } : {}),
    ...(data.receptionistNumber ? { telephone: data.receptionistNumber } : {}),
  };
  if (data.addressStreet && data.addressCity) {
    ld.address = {
      "@type": "PostalAddress",
      streetAddress: data.addressStreet,
      addressLocality: data.addressCity,
      ...(data.addressRegion ? { addressRegion: data.addressRegion } : {}),
      ...(data.addressPostal ? { postalCode: data.addressPostal } : {}),
      addressCountry: "US",
    };
  }
  if (data.reviewSummary.count > 0 && data.reviewSummary.avgRating !== null) {
    // 🔴 RATINGS AND REVIEWS ARE DIFFERENT NUMBERS NOW. The average covers
    // every approved rating, star-only ones included, so that is its
    // `ratingCount`. Only ratings WITH words are shown as reviews on the page,
    // so `reviewCount` is those - and it is left out at zero (or when an older
    // API did not send it) rather than claiming reviews the page never shows.
    const written = data.reviewSummary.writtenCount ?? 0;
    ld.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: Number(data.reviewSummary.avgRating.toFixed(2)),
      ratingCount: data.reviewSummary.count,
      ...(written > 0 ? { reviewCount: written } : {}),
      bestRating: 5,
      worstRating: 1,
    };
  }
  return ld;
}
