import type { Metadata } from "next";
import type { BookingModeKey } from "@chairback/config/constants";
import { apiGet } from "@/lib/api";
import { DemoTour } from "@/components/tour/DemoTour";
import { PageEditor } from "./PageEditor";

export const metadata: Metadata = { title: "Your page" };

export interface ShopPageSettings {
  name: string;
  slug: string | null;
  // Vertical key ("barber" | "salon" | ...) — the live preview needs it for
  // noun-correct copy (ShopPageData.industry).
  industry: string;
  publicPageEnabled: boolean;
  theme: string;
  bio: string | null;
  logoUrl: string | null;
  accentColor: string | null;
  heroImageUrl: string | null;
  instagramHandle: string | null;
  hoursText: string | null;
  gallery: { url: string; caption?: string }[];
  fontKey: string | null;
  layoutStyle: string | null;
  sectionOrder: string[];
  // Client rewards page content control.
  rewardsWelcome: string | null;
  rewardsSections: string[];
  takesRequests: boolean;
  waitlistEnabled: boolean;
  notifyPhone: string | null;
  bookingUrl: string | null;
  bookingMode: BookingModeKey;
  punchesPerVisit: number;
}

export default async function PageSettingsPage() {
  const res = await apiGet<ShopPageSettings>("/api/shops/me");
  if (!res.ok || !res.data) {
    return <main className="p-8 text-muted">Could not load your page settings.</main>;
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-8">
      {/* Barber-side guided tour. data-tour: keep in sync with
          packages/config/src/demoTour.ts (DASHBOARD_TOUR_STEPS). */}
      <DemoTour tour="dashboard" route="site" />
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Your page</h1>
        <p className="mt-1 text-sm text-muted">
          A public mini-site that looks like your shop. Customize it however you
          like and watch it update live. Drop the link in your Instagram bio.
        </p>
      </header>
      <div data-tour="site-setup">
        <PageEditor settings={res.data} appBase={process.env.APP_BASE_URL ?? ""} />
      </div>
    </main>
  );
}
