import { businessType } from "@chairback/config/businessTypes";
import type { ShopPageData } from "./page";

/** The slice of the public page payload the structured data is built from. */
export type ShopJsonLdInput = Pick<
  ShopPageData,
  | "name"
  | "slug"
  | "industry"
  | "bio"
  | "logoUrl"
  | "receptionistNumber"
  | "addressStreet"
  | "addressCity"
  | "addressRegion"
  | "addressPostal"
  | "reviewSummary"
>;

/**
 * LocalBusiness structured data - the piece that makes the shop's ChairBack
 * page read as a BUSINESS to Google (name + address + rating rich results,
 * local-pack eligibility), not just a web page. aggregateRating only with 1+
 * approved reviews (Google flags a rating block with zero reviews as spammy
 * markup).
 *
 * Its own module (not inside page.tsx) so it can be tested: a Next.js page file
 * may only export the names Next.js knows about.
 *
 * THE ADDRESS IS WHATEVER THE PUBLIC PAYLOAD CARRIES, and that payload is
 * already the stranger's view (publicShopAddress in @chairback/config): a shop
 * that keeps its address private arrives here with street and ZIP null. So:
 *
 *   - street + city -> the full PostalAddress;
 *   - city, no street -> the locality alone (city, state, country), which
 *     still places the shop in local search without putting its door on the
 *     map - the whole point of keeping the street private;
 *   - no city -> no address at all: a street or a state on its own is not a
 *     place anyone can find.
 */
export function shopJsonLd(data: ShopJsonLdInput): Record<string, unknown> {
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
  const city = data.addressCity?.trim();
  if (city) {
    const street = data.addressStreet?.trim();
    ld.address = {
      "@type": "PostalAddress",
      ...(street ? { streetAddress: street } : {}),
      addressLocality: city,
      ...(data.addressRegion ? { addressRegion: data.addressRegion } : {}),
      // A ZIP narrows a town to a few blocks: it travels with a street only.
      ...(street && data.addressPostal ? { postalCode: data.addressPostal } : {}),
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
