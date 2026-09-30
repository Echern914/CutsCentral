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
  // The owner's view: the full stored address, even when it is private.
  addressStreet: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostal: string | null;
  // Keep the street off the public page, Google and the receptionist. Optional
  // only for the deploy window where this page is newer than the API.
  addressPrivate?: boolean;
  /** PAGE_DESIGNS key. Optional only for the deploy window where this page is newer than the API. */
  pageDesign?: string;
  gallery: { url: string; caption?: string; serviceId?: string; staffId?: string; addedAt?: string }[];
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

/**
 * The shop's services and team, for tagging photos and for the live preview
 * of the designs that show them. Same rows the Booking settings list.
 */
export interface PageMenu {
  services: {
    id: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
    durationMin: number;
    price: number | null;
    active: boolean;
    visibility?: string;
  }[];
  staff: { id: string; name: string; imageUrl: string | null; active: boolean }[];
}

export default async function PageSettingsPage() {
  const [res, domainRes, servicesRes, staffRes] = await Promise.all([
    apiGet<ShopPageSettings>("/api/shops/me"),
    apiGet<DomainStatus>("/api/domains"),
    apiGet<{ services: PageMenu["services"] }>("/api/booking/services"),
    apiGet<{ staff: PageMenu["staff"] }>("/api/booking/staff"),
  ]);
  if (!res.ok || !res.data) {
    return <main className="p-8 text-muted">Could not load your page settings.</main>;
  }
  // Tagging is an extra: without the lists the editor simply offers no tags.
  const menu: PageMenu = {
    services: servicesRes.ok && servicesRes.data ? servicesRes.data.services : [],
    staff: staffRes.ok && staffRes.data ? staffRes.data.staff : [],
  };

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
        <PageEditor settings={res.data} menu={menu} appBase={process.env.APP_BASE_URL ?? ""} />
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
              : { available: false, domain: null, verifiedAt: null, records: [], dns: null, vercel: null }
          }
        />
      </div>
    </main>
  );
}
