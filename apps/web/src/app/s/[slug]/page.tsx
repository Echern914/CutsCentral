import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  APP_NAME,
  serviceNounForShop,
  type BookingModeKey,
} from "@chairback/config/constants";
import { apiPublicGet } from "@/lib/api";
import { GetTheApp } from "@/components/GetTheApp";
import { appleItunesApp } from "@/lib/appBanner";
import { ShopPageClient } from "./ShopPageClient";

export interface ShopPageData {
  name: string;
  slug: string;
  bio: string | null;
  // Vertical key ("barber" | "salon" | "nails" | ...) for noun-correct copy;
  // serviceNoun is the shop's own word for a visit when they set one ("twist").
  industry: string;
  serviceNoun: string | null;
  /** The shop's AI text line, or null when texting wouldn't be answered. */
  receptionistNumber?: string | null;
  theme: string;
  logoUrl: string | null;
  heroImageUrl: string | null;
  accentColor: string | null;
  instagramHandle: string | null;
  /** Shop's Google "write a review" link; null = the CTA never renders. */
  googleReviewUrl: string | null;
  hoursText: string | null;
  addressStreet: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostal: string | null;
  gallery: { url: string; caption?: string }[];
  fontKey: string | null;
  layoutStyle: string | null;
  sectionOrder: string[];
  bookingUrl: string | null;
  bookingMode: BookingModeKey;
  takesRequests: boolean;
  waitlistEnabled: boolean;
  punchesPerVisit: number;
  rewards: {
    id: string;
    name: string;
    description: string | null;
    emoji: string | null;
    punchCost: number;
  }[];
  promotions: {
    id: string;
    kind: "PERCENT_OFF" | "AMOUNT_OFF" | "FREE_ADDON" | "EXTRA_PUNCHES";
    title: string;
    description: string | null;
    code: string | null;
    percentOff: number | null;
    amountOff: number | null;
    extraPunches: number | null;
    endsAt: string | null;
  }[];
  // Approved reviews only (the API never returns pending/hidden publicly).
  reviews: {
    id: string;
    rating: number;
    body: string | null;
    authorName: string | null;
    createdAt: string;
  }[];
  reviewSummary: { count: number; avgRating: number | null };
}

// Cache the public shop-page data (theme, bio, reviews, promotions) for 60s.
// This does two things: the metadata + render calls to the SAME endpoint dedupe
// into one upstream request, and repeat visitors within the window get a cached
// response instead of a ~1s API+DB round trip. A barber's edit appears within
// 60s. (The live booking-slots feed on /book is deliberately NOT cached.)
const SHOP_PAGE_REVALIDATE_S = 60;

async function getData(slug: string): Promise<ShopPageData | null> {
  const res = await apiPublicGet<ShopPageData>(
    `/api/page/${encodeURIComponent(slug)}`,
    SHOP_PAGE_REVALIDATE_S,
  );
  return res.ok ? res.data : null;
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const data = await getData(params.slug);
  if (!data) return { title: APP_NAME };
  const description =
    data.bio ??
    `Book your next ${serviceNounForShop(data)} at ${data.name} and earn rewards every visit.`;
  return {
    title: data.name,
    description,
    openGraph: {
      title: data.name,
      description,
      type: "website",
      ...(data.heroImageUrl ? { images: [{ url: data.heroImageUrl }] } : {}),
    },
    twitter: { card: "summary_large_image", title: data.name, description },
  };
}

/**
 * schema.org business type by vertical - the most specific type Google
 * recognizes for each. Specificity matters: "BarberShop" is eligible for
 * treatments a generic LocalBusiness is not.
 */
const SCHEMA_TYPE_BY_INDUSTRY: Record<string, string> = {
  barber: "BarberShop",
  salon: "HairSalon",
  nails: "NailSalon",
  lashes: "BeautySalon",
  spa: "DaySpa",
  tattoo: "TattooParlor",
  other: "LocalBusiness",
};

/**
 * LocalBusiness structured data - the piece that makes the shop's ChairBack
 * page read as a BUSINESS to Google (name + address + rating rich results,
 * local-pack eligibility), not just a web page. Address is included only when
 * street + city are both set; aggregateRating only with 1+ approved reviews
 * (Google flags a rating block with zero reviews as spammy markup).
 */
function shopJsonLd(data: ShopPageData): Record<string, unknown> {
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": SCHEMA_TYPE_BY_INDUSTRY[data.industry] ?? "LocalBusiness",
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
    ld.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: Number(data.reviewSummary.avgRating.toFixed(2)),
      reviewCount: data.reviewSummary.count,
      bestRating: 5,
      worstRating: 1,
    };
  }
  return ld;
}

export default async function PublicShopPage({
  params,
}: {
  params: { slug: string };
}) {
  const data = await getData(params.slug);
  if (!data) notFound();
  return (
    <>
      {/* JSON.stringify output is safe inside a script tag except for a
          literal "</script>" in a string field - the < escape closes that
          hole. Standard Next.js JSON-LD pattern. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(shopJsonLd(data)).replace(/</g, "\\u003c"),
        }}
      />
      <ShopPageClient data={data} />
      <div className="mx-auto w-full max-w-2xl px-4 pb-8">
        <GetTheApp surface="shop" />
      </div>
    </>
  );
}
