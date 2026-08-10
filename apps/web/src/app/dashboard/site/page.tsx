import type { Metadata } from "next";
import type { BookingModeKey } from "@chairback/config/constants";
import { apiGet } from "@/lib/api";
import { DemoTour } from "@/components/tour/DemoTour";
import { PageEditor } from "./PageEditor";
import { DomainCard } from "./DomainCard";
import type { DomainStatus } from "./domainActions";

export const metadata: Metadata = { title: "Your page" };

export interface ShopPageSettings {
  name: string;
  slug: string | null;
  // Vertical key ("barber" | "salon" | ...) — the live preview needs it for
  // noun-correct copy (ShopPageData.industry). serviceNoun is the shop's own
  // word for a visit when set, overriding the industry noun.
  industry: string;
  serviceNoun: string | null;
  publicPageEnabled: boolean;
  theme: string;
  bio: string | null;
  logoUrl: string | null;
  accentColor: string | null;
  heroImageUrl: string | null;
  instagramHandle: string | null;
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
  const [res, domainRes] = await Promise.all([
    apiGet<ShopPageSettings>("/api/shops/me"),
    apiGet<DomainStatus>("/api/domains"),
  ]);
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
      {/* Custom domain: separate from the editor on purpose - it's a stateful
          connect/verify flow, not a form field, and must never ride (or dirty)
          the diff-save above. Renders an "email support" card if the status
          read failed or the feature seam is unset. */}
      <div className="mt-6 max-w-2xl">
        <DomainCard
          initial={
            domainRes.ok && domainRes.data
              ? domainRes.data
              : { available: false, domain: null, verifiedAt: null, records: [], vercel: null }
          }
        />
      </div>
    </main>
  );
}
