import type { Metadata } from "next";
import Link from "next/link";
import { APP_NAME, BILLING, PLANS } from "@chairback/config/constants";
import { PricingSection } from "@/components/marketing/PricingSection";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { SiteHeader } from "@/components/marketing/SiteHeader";

/**
 * Standalone pricing page - what people type and what ads deep-link to.
 * Replaces the old /pricing -> /#pricing redirect (bad for ads/SEO: the
 * destination was a fragment on the homepage, so the URL couldn't rank or be
 * A/B-measured on its own). The grid itself is the shared PricingSection,
 * which renders nothing inside the native app (App Store 3.1.1) - and no
 * in-app surface links here.
 */

const description = `${APP_NAME} pricing: ${PLANS.starter.name} ($${
  PLANS.starter.priceMonthlyUsd
}/mo, online booking) or ${PLANS.pro.name} ($${PLANS.pro.priceMonthlyUsd}/mo, rebooking reminders and full Insights). ${BILLING.trialDays}-day free trial, no contracts.`;

export const metadata: Metadata = {
  title: "Pricing",
  description,
  openGraph: {
    title: `${APP_NAME} Pricing`,
    description,
    type: "website",
    // Page-level openGraph REPLACES the root's (Next 14 doesn't deep-merge),
    // so restate the site name.
    siteName: APP_NAME,
  },
};

export default function PricingPage() {
  return (
    <div className="relative min-h-dvh overflow-x-clip">
      <SiteHeader />

      <main>
        {/* Visually-hidden h1: PricingSection's heading is an h2 (it renders as
            a section on the homepage too), but a standalone page should start
            its heading hierarchy - and rank - on an h1. */}
        <h1 className="sr-only">{APP_NAME} pricing</h1>
        <PricingSection />
        <p className="mx-auto w-full max-w-6xl px-6 pb-16 text-center text-sm text-muted">
          Questions?{" "}
          <Link href="/" className="text-gold hover:underline">
            See the full tour
          </Link>{" "}
          or{" "}
          <Link href="/support" className="text-gold hover:underline">
            ask us anything
          </Link>
          .
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
