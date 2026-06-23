import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { APP_NAME } from "@chairback/config/constants";
import { apiPublicGet } from "@/lib/api";
import { BookingClient } from "./BookingClient";

export interface BookShopData {
  shop: {
    name: string;
    slug: string;
    timezone: string;
    logoUrl: string | null;
    accentColor: string | null;
    bookingLeadHours: number;
    bookingMaxDays: number;
  };
  staff: { id: string; name: string; bio: string | null; imageUrl: string | null }[];
  services: {
    id: string;
    name: string;
    description: string | null;
    durationMin: number;
    price: number | null;
  }[];
  offerings: { serviceId: string; staffId: string }[];
}

async function getData(slug: string): Promise<BookShopData | null> {
  const res = await apiPublicGet<BookShopData>(`/api/book/${encodeURIComponent(slug)}`);
  return res.ok ? res.data : null;
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const data = await getData(params.slug);
  if (!data) return { title: APP_NAME };
  return {
    title: `Book at ${data.shop.name}`,
    description: `Book your appointment at ${data.shop.name}.`,
    robots: { index: false }, // booking funnel, not a landing page
  };
}

export default async function BookPage({
  params,
}: {
  params: { slug: string };
}) {
  const data = await getData(params.slug);
  if (!data) notFound();
  return <BookingClient data={data} />;
}
