import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  APP_NAME,
  serviceNounForShop,
  type BookingModeKey,
} from "@chairback/config/constants";
import { apiPublicGet } from "@/lib/api";
import { DOMAIN_PARAM, expectedDomain, servesDomain } from "@/lib/customDomainGuard";
import { GetTheApp } from "@/components/GetTheApp";
import { appleItunesApp } from "@/lib/appBanner";
import { ShopPageClient } from "./ShopPageClient";
import { shopJsonLd } from "./shopJsonLd";

export interface ShopPageData {
  name: string;
  slug: string;
  /**
   * The shop's own domain, once VERIFIED; null otherwise. Absent only from an
   * API that predates it. Decides whether a custom-domain visit may render
   * this shop - see lib/customDomainGuard.ts.
   */
  customDomain?: string | null;
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
  // The PUBLIC view of the address: a shop that keeps its address private
  // sends street and ZIP as null (city and region still come through).
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
  // Approved reviews WITH TEXT only - the cards (the API never returns
  // pending/hidden publicly, and never a star-only rating as a card).
  reviews: {
    id: string;
    rating: number;
    body: string | null;
    authorName: string | null;
    createdAt: string;
  }[];
  reviewSummary: {
    /** Every approved RATING, star-only ones included - what the average covers. */
    count: number;
    avgRating: number | null;
    /** Approved reviews with text (the list above is capped). Absent from an older API. */
    writtenCount?: number;
  };
}

// Cache the public shop-page data (theme, bio, reviews, promotions) for 60s.
// This does two things: the metadata + render calls to the SAME endpoint dedupe
// into one upstream request, and repeat visitors within the window get a cached
// response instead of a ~1s API+DB round trip. A barber's edit appears within
// 60s. (The live booking-slots feed on /book is deliberately NOT cached.)
const SHOP_PAGE_REVALIDATE_S = 60;

async function getData(slug: string, fresh = false): Promise<ShopPageData | null> {
  const res = await apiPublicGet<ShopPageData>(
    `/api/page/${encodeURIComponent(slug)}`,
    fresh ? undefined : SHOP_PAGE_REVALIDATE_S,
  );
  return res.ok ? res.data : null;
}

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The page for THIS visit, or null when it must not render.
 *
 * 🔴 A visit redirected from a custom domain renders only the shop that owns
 * that domain. The redirect looked the slug up a moment ago; by the time the
 * browser arrives the slug may belong to someone else. Then this fails closed
 * - a plain not-found, never the other shop. A mismatch is re-read once,
 * uncached, before refusing: the cached copy can predate the domain being
 * verified, and that must not turn away the shop's own visitors.
 */
async function getDataFor(slug: string, searchParams?: SearchParams): Promise<ShopPageData | null> {
  const expected = expectedDomain(searchParams);
  const data = await getData(slug);
  if (expected === null || servesDomain(data, expected)) return data;
  const fresh = await getData(slug, true);
  return servesDomain(fresh, expected) ? fresh : null;
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams?: SearchParams;
}): Promise<Metadata> {
  const data = await getDataFor(params.slug, searchParams);
  // Refused or missing: nothing of any shop's - not even its name in a tab.
  if (!data) return { title: APP_NAME, robots: { index: false } };
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

export default async function PublicShopPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams?: SearchParams;
}) {
  const data = await getDataFor(params.slug, searchParams);
  if (!data) notFound();
  // The visitor's next tap is Book - same check there, so pass the marker on.
  const expected = expectedDomain(searchParams);
  const bookQuery =
    expected && expected !== "invalid" ? `?${DOMAIN_PARAM}=${encodeURIComponent(expected)}` : undefined;
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
      <ShopPageClient data={data} bookQuery={bookQuery} />
      <div className="mx-auto w-full max-w-2xl px-4 pb-8">
        <GetTheApp surface="shop" />
      </div>
    </>
  );
}
