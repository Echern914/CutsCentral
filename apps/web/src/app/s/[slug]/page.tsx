import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { APP_NAME } from "@chairback/config/constants";
import { apiPublicGet } from "@/lib/api";
import { ShopPageClient } from "./ShopPageClient";

export interface ShopPageData {
  name: string;
  slug: string;
  bio: string | null;
  theme: string;
  logoUrl: string | null;
  heroImageUrl: string | null;
  accentColor: string | null;
  instagramHandle: string | null;
  hoursText: string | null;
  gallery: { url: string; caption?: string }[];
  fontKey: string | null;
  layoutStyle: string | null;
  sectionOrder: string[];
  bookingUrl: string;
  bookingMode: "link" | "acuity" | "native";
  takesRequests: boolean;
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

async function getData(slug: string): Promise<ShopPageData | null> {
  const res = await apiPublicGet<ShopPageData>(`/api/page/${encodeURIComponent(slug)}`);
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
    data.bio ?? `Book your next cut at ${data.name} and earn rewards every visit.`;
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
}: {
  params: { slug: string };
}) {
  const data = await getData(params.slug);
  if (!data) notFound();
  return <ShopPageClient data={data} />;
}
