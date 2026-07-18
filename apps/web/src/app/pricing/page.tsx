import type { Metadata } from "next";
import Link from "next/link";
import { APP_NAME, BILLING, PLANS } from "@chairback/config/constants";
import { PricingSection } from "@/components/marketing/PricingSection";
import { ScissorsMark } from "@/components/marketing/PunchCardDemo";

/**
 * Standalone pricing page - what people type and what ads deep-link to.
 * Replaces the old /pricing -> /#pricing redirect (bad for ads/SEO: the
 * destination was a fragment on the homepage, so the URL couldn't rank or be
 * A/B-measured on its own). The grid itself is the shared PricingSection,
 * which renders nothing inside the native app (App Store 3.1.1) - and no
 * in-app surface links here.
 */

const description = `${APP_NAME} pricing: run loyalty free forever, add ${
  PLANS.pro.name
} ($${PLANS.pro.priceMonthlyUsd}/mo, ${PLANS.pro.smsMonthlyQuota} texts) or ${
  PLANS.pro_ai.name
} ($${PLANS.pro_ai.priceMonthlyUsd}/mo with a 24/7 AI receptionist). ${
  BILLING.trialDays
}-day free trial, no contracts.`;

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
      {/* Same minimal marketing chrome as the landing page nav. */}
      <header className="sticky top-0 z-20">
        <nav
          aria-label="Primary"
          className="glass mx-auto mt-4 flex w-[min(72rem,calc(100%-2rem))] items-center justify-between rounded-full px-5 py-3"
        >
          <Link href="/" className="flex items-center gap-2">
            <ScissorsMark className="h-4 w-4 text-gold" />
            <span className="font-display text-base tracking-tight">{APP_NAME}</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="rounded-full px-4 py-2 text-sm text-muted transition-colors duration-150 ease-out hover:text-offwhite"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="rounded-full bg-gold-gradient px-4 py-2 text-sm font-semibold text-charcoal shadow-glow-sm transition-[box-shadow,filter] duration-150 ease-out hover:shadow-glow hover:brightness-105"
            >
              Get started
            </Link>
          </div>
        </nav>
      </header>

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
    </div>
  );
}
