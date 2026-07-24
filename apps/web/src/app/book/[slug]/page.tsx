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
    // True when the shop's subscription/trial has lapsed: the create POST
    // would 403, so the UI shows a "booking paused" notice instead of the flow.
    bookingPaused?: boolean;
    // When on, the booking page offers "Join the waitlist" (a standing button
    // and when a chosen day is fully booked).
    waitlistEnabled?: boolean;
    // When on (and the shop has groups), the menu opens with group cards
    // instead of the full flat service list.
    groupsFirst?: boolean;
    // Fee-free direct-payment handles (display-only); null when the barber hasn't
    // turned it on. Shown on the confirmation so the customer can pay directly.
    payDirect: {
      zelle: string | null;
      venmo: string | null;
      cashApp: string | null;
      note: string | null;
    } | null;
  };
  staff: { id: string; name: string; bio: string | null; imageUrl: string | null }[];
  services: {
    id: string;
    name: string;
    description: string | null;
    // Per-service menu photo (https URL) + calendar-color KEY (SERVICE_COLORS).
    // Both cosmetic on the card: photo = thumbnail, color = left-edge accent.
    imageUrl: string | null;
    color: string | null;
    durationMin: number;
    price: number | null;
    // Per-weekday price overrides ({ "0": 55 } = Sunday $55); the client picks the
    // right one for the chosen day. priceRange spans base + overrides for the menu.
    priceOverrides: Record<string, number>;
    priceRange: { min: number; max: number } | null;
    // Same for duration ({ "5": 20 } = Friday 20 min) - the menu shows the
    // range, the picker the exact length for the chosen day.
    durationOverrides: Record<string, number>;
    durationRange: { min: number; max: number };
    // Groups-first: which group card this files under (null = ungrouped) and
    // its saved position within that group.
    serviceGroupId: string | null;
    groupSortOrder: number;
  }[];
  // Group cards for the groups-first menu, in display order.
  groups: { id: string; name: string }[];
  offerings: { serviceId: string; staffId: string }[];
  // Barber-published one-off special slots (future, active, unbooked), shown
  // under their parent service with a badge + their own price.
  targetedSlots: {
    id: string;
    staffId: string;
    serviceId: string;
    label: string | null;
    startsAt: string;
    durationMin: number;
    price: number;
  }[];
  // Optional extras. serviceIds [] = offered on every service; non-empty = only
  // with those. The client shows those valid for the chosen service.
  addOns: {
    id: string;
    name: string;
    durationMin: number;
    price: number | null;
    serviceIds: string[];
  }[];
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
