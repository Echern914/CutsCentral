import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { BookingModeKey } from "@chairback/config/constants";
import { DOMAIN_PARAM, expectedDomain } from "@/lib/customDomainGuard";
import { loadShopPage, shopPageMetadata, shopPageTree } from "./shopPage";

/**
 * A gallery photo. `serviceId` / `staffId` arrive only while they name a
 * service a client may book and someone still on the team; `addedAt` only on
 * photos added since dates existed.
 */
export interface PagePhoto {
  url: string;
  caption?: string;
  serviceId?: string;
  staffId?: string;
  addedAt?: string;
}

/** A service a client may book, as the public page shows it. */
export interface PageService {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  durationMin: number;
  price: number | null;
}

/** Someone on the team, as the public page shows them. */
export interface PageStaff {
  id: string;
  name: string;
  imageUrl: string | null;
}

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
  /**
   * PAGE_DESIGNS key - the whole-page layout. Absent from an API older than
   * designs, and anything unknown, renders classic (pageDesignFor).
   */
  pageDesign?: string;
  gallery: PagePhoto[];
  /**
   * The bookable menu and the team, for the designs that show them. Empty for
   * a shop that books somewhere else; absent from an API older than designs.
   */
  services?: PageService[];
  staff?: PageStaff[];
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

type SearchParams = Record<string, string | string[] | undefined>;

/*
 * The page at getchairback.com/s/<slug>. The same page is served on a shop's
 * own domain (app/custom-domain/[host]); both read, check and draw it through
 * ./shopPage.
 *
 * A visit carrying `?cb_domain=` came through a custom domain - a booking
 * redirect, or a link copied while one was on screen - and renders only if
 * this shop owns that domain (loadShopPage).
 */

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams?: SearchParams;
}): Promise<Metadata> {
  return shopPageMetadata(await loadShopPage(params.slug, expectedDomain(searchParams)));
}

export default async function PublicShopPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams?: SearchParams;
}) {
  const expected = expectedDomain(searchParams);
  const data = await loadShopPage(params.slug, expected);
  if (!data) notFound();
  // The visitor's next tap is Book - same check there, so pass the marker on.
  const bookQuery =
    expected && expected !== "invalid" ? `?${DOMAIN_PARAM}=${encodeURIComponent(expected)}` : undefined;
  return shopPageTree(data, { bookQuery });
}
