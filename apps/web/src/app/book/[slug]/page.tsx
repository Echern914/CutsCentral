import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { APP_NAME } from "@chairback/config/constants";
import type { BusinessVocabulary } from "@chairback/config/businessTypes";
import { apiPublicGet } from "@/lib/api";
import { BookingClient } from "./BookingClient";
import { GetTheApp } from "@/components/GetTheApp";
import { RewardsDoor } from "@/components/RewardsDoor";
import { appleItunesApp } from "@/lib/appBanner";

export interface BookShopData {
  shop: {
    name: string;
    slug: string;
    timezone: string;
    /**
     * What this business calls its people and visits, resolved by the API.
     * Optional so a web deploy ahead of the API keeps today's copy; absent or
     * unselected falls back to NEUTRAL, never to barbershop wording.
     */
    vocabulary?: BusinessVocabulary;
    logoUrl: string | null;
    accentColor: string | null;
    // Instagram handle WITHOUT the "@" (the API strips it on save).
    instagramHandle: string | null;
    bookingLeadHours: number;
    bookingMaxDays: number;
    // True when the shop's subscription/trial has lapsed: the create POST
    // would 403, so the UI shows a "booking paused" notice instead of the flow.
    bookingPaused?: boolean;
    // When on, the booking page offers "Join the waitlist" (a standing button
    // and when a chosen day is fully booked).
    waitlistEnabled?: boolean;
    /** True while confirmations go by email only - the form then requires it. */
    emailRequired?: boolean;
    // When on (and the shop has groups), the menu opens with group cards
    // instead of the full flat service list.
    groupsFirst?: boolean;
    /**
     * Whether the prices shown already include a tip.
     *
     * Optional AND nullable, and both matter: undefined means an older API
     * that predates the field, null means the barber has deliberately not
     * said. Both render nothing - the page never guesses a shop’s tipping
     * policy on their behalf.
     */
    tipPolicy?: "included" | "not_included" | null;
    // Fee-free direct-payment handles (display-only); null when the barber hasn't
    // turned it on. Shown on the confirmation so the customer can pay directly.
    payDirect: {
      zelle: string | null;
      venmo: string | null;
      cashApp: string | null;
      note: string | null;
    } | null;
    /**
     * Whether the form may offer a standing appointment. Decided by the API
     * with the SAME predicate the create route refuses with, so this page
     * never offers what the write would turn down. Optional so a web deploy
     * ahead of the API simply does not offer it.
     */
    recurringAvailable?: boolean;
    /** The most occurrences a customer may book in one tap (API-owned). */
    recurringMaxCount?: number;
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
    // Time-of-day windows ([{s,e,price,durationMin}] in SHOP-local minutes, e
    // exclusive, every day) layered over the weekday overrides - the client
    // resolves each slot's exact price/length from the slot's own start time.
    // `days` = weekdays the window repeats on ([] / absent = every day);
    // `opensHours` = it also opens that time past the staff schedule.
    timeOverrides: {
      s: number;
      e: number;
      days?: number[];
      price: number | null;
      durationMin: number | null;
      opensHours?: boolean;
    }[];
    // Groups-first: which group card this files under (null = ungrouped) and
    // its saved position within that group.
    serviceGroupId: string | null;
    groupSortOrder: number;
  }[];
  // Group cards for the groups-first menu, in display order.
  groups: { id: string; name: string }[];
  // Weekdays (0-6, shop-local) with any staff availability — the day-first
  // calendar's pickable-day heuristic (real slots fetched per day on tap).
  openWeekdays: number[];
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

// Cache the booking SHELL (shop meta, staff, services, add-ons) for 30s: dedupes
// the metadata + render calls and spares repeat visitors the ~1s API round trip.
// This is only the static menu — the live per-day availability is a SEPARATE,
// uncached client call (/api/book/:slug/day), so open times are never stale.
// 30s (shorter than the shop page) because it also lists targeted slots, which
// the booking-write overlap guard backstops anyway.
const BOOK_SHELL_REVALIDATE_S = 30;

async function getData(slug: string): Promise<BookShopData | null> {
  const res = await apiPublicGet<BookShopData>(
    `/api/book/${encodeURIComponent(slug)}`,
    BOOK_SHELL_REVALIDATE_S,
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
  return {
    title: `Book at ${data.shop.name}`,
    description: `Book your appointment at ${data.shop.name}.`,
    robots: { index: false }, // booking funnel, not a landing page
    // iOS Safari draws Apple's own install banner from this.
    other: { ...appleItunesApp() },
  };
}

export default async function BookPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams?: { service?: string; staff?: string };
}) {
  const data = await getData(params.slug);
  if (!data) notFound();
  // 🔴 A PREFILL, NOT A PERMISSION. `?service=` and `?staff=` only pre-pick
  // what the client could have tapped themselves two screens in - these ids
  // are already public on this page. BookingClient validates them against what
  // this shop actually offers and ignores anything else, so a stale link from
  // a months-old text lands on the ordinary booking page rather than an error.
  const prefill =
    searchParams?.service || searchParams?.staff
      ? { serviceId: searchParams.service ?? null, staffId: searchParams.staff ?? null }
      : null;
  return (
    <>
      <BookingClient data={data} prefill={prefill} />
      {/* Below the flow, never above it: the booking is what they came for. */}
      <div className="mx-auto w-full max-w-2xl px-4 pb-8">
        <GetTheApp surface="booking" />
        <RewardsDoor />
      </div>
    </>
  );
}
