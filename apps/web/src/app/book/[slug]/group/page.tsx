import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { APP_NAME } from "@chairback/config/constants";
import { apiPublicGet } from "@/lib/api";
import { appleItunesApp } from "@/lib/appBanner";
import type { BookShopData } from "../page";
import { GroupBookingClient } from "./GroupBookingClient";

/**
 * Booking 2 or 3 people back to back, on its own route.
 *
 * 🔴 /book/[slug] REMAINS AUTHORITATIVE FOR ONE PERSON. This page is additive:
 * the single-booking flow is not touched, not wrapped and not refactored, so
 * the path every ordinary customer takes is byte-for-byte what it was.
 *
 * It reuses the SAME payload the single page loads (`BookShopData`), so the
 * staff list, the service menu and which chair offers what cannot drift
 * between the two screens.
 */

export const metadata: Metadata = {
  title: `Book for 2 or 3 people · ${APP_NAME}`,
  robots: { index: false }, // a booking funnel, not a landing page
  other: { ...appleItunesApp() },
};

async function getData(slug: string): Promise<BookShopData | null> {
  const res = await apiPublicGet<BookShopData>(`/api/book/${encodeURIComponent(slug)}`);
  return res.ok && res.data ? res.data : null;
}

export default async function GroupBookPage({ params }: { params: { slug: string } }) {
  const data = await getData(params.slug);
  if (!data) notFound();

  // 🔴 SAID HERE, BEFORE ANY FORM IS DRAWN. A shop that takes money at booking
  // cannot take a group booking at all - the API refuses one outright, because
  // a deposit covering several appointments raises questions about what is
  // refunded to whom when one attendee cancels. Walking someone through four
  // screens and refusing at Confirm would be the cruel way to say that.
  const collectsAtBooking = Boolean(data.shop.payment?.collects);
  if (collectsAtBooking) {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-8">
        <h1 className="mb-3 text-2xl font-semibold text-offwhite">Group booking</h1>
        <p className="text-muted">
          Group booking isn&apos;t available online for {data.shop.name}. You can still
          book each person separately, or call the shop to arrange it together.
        </p>
        <Link
          href={`/book/${params.slug}`}
          className="mt-5 inline-block rounded-xl bg-gold px-5 py-2.5 font-semibold text-charcoal-900"
        >
          Book one person
        </Link>
      </main>
    );
  }

  // A lapsed shop's create would 403; say so rather than offer a dead flow.
  if (data.shop.bookingPaused) {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-8">
        <h1 className="mb-3 text-2xl font-semibold text-offwhite">Booking paused</h1>
        <p className="text-muted">
          {data.shop.name} isn&apos;t taking online bookings right now.
        </p>
      </main>
    );
  }

  return <GroupBookingClient data={data} />;
}
