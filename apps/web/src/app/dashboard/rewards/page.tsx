import type { Metadata } from "next";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { getMe } from "@/lib/me";
import { DemoTour } from "@/components/tour/DemoTour";
import { RewardsBuilder } from "./RewardsBuilder";
import { TierPerks } from "./TierPerks";

export const metadata: Metadata = { title: "Rewards" };

export interface LoyaltyConfig {
  punchesPerVisit: number;
  /** What each loyalty tier is worth at this shop. Every key optional. */
  tierPerks: Partial<Record<"BRONZE" | "SILVER" | "GOLD", string>>;
  /** What it takes to reach each tier at this shop (defaults when unset). */
  tierThresholds?: Record<"BRONZE" | "SILVER" | "GOLD", number>;
  cards: {
    id: string;
    name: string;
    description: string | null;
    emoji: string | null;
    accentColor: string | null;
    serviceMatch: string[];
    punchesPerVisit: number;
    exclusive: boolean;
    active: boolean;
    sortOrder: number;
    grantCount: number;
    hasActivity: boolean;
  }[];
  rewards: {
    id: string;
    name: string;
    description: string | null;
    emoji: string | null;
    punchCost: number;
    cardTypeId: string | null;
    active: boolean;
    sortOrder: number;
    timesRedeemed: number;
  }[];
  rules: {
    id: string;
    serviceMatch: string;
    punches: number;
    active: boolean;
    sortOrder: number;
  }[];
}

export default async function RewardsPage() {
  // Fetch identity + loyalty config in parallel (they don't depend on each
  // other) instead of waiting for /me before even starting /api/loyalty. getMe
  // is memoized so it's ~free; this removes a serial API hop from the load.
  const [me, res] = await Promise.all([getMe(), apiGet<LoyaltyConfig>("/api/loyalty")]);

  // Rewards off (deep link / stale tab - the nav pill is already hidden): a
  // clear "flip it on in Settings" note instead of a dead builder.
  if (me.ok && me.data && !me.data.rewardsEnabled) {
    return (
      <main className="mx-auto w-full max-w-xl px-5 py-16 text-center">
        <h1 className="font-display text-2xl">Rewards are off</h1>
        <p className="mt-2 text-sm text-muted">
          Punch cards &amp; rewards are turned off for this shop, so clients
          don&apos;t see any of it. Flip them on from the Settings card to
          build your reward menu - any punches already earned are safe.
        </p>
        <Link
          href="/dashboard"
          className="mt-5 inline-block rounded-full bg-gold px-5 py-2 text-sm font-semibold text-charcoal-900"
        >
          Go to Settings
        </Link>
      </main>
    );
  }

  if (!res.ok || !res.data) {
    return <main className="p-8 text-muted">Could not load your rewards setup.</main>;
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8">
      {/* Barber-side guided tour. data-tour: keep in sync with
          packages/config/src/demoTour.ts */}
      <DemoTour tour="dashboard" route="rewards-manager" />
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Rewards</h1>
        <p className="mt-1 text-sm text-muted">
          Design your own program: what clients can earn, and how fast they earn it.
          Everything here shows up on your clients&apos; rewards page.
        </p>
      </header>
      <div data-tour="menu">
        <RewardsBuilder config={res.data} />
      </div>
      {/* 🔴 The feature registry has always pointed "Loyalty status tiers" at
          this page, and this page had nothing about tiers on it - an owner
          searching "gold" landed somewhere that never said the word. */}
      <TierPerks
        initial={res.data.tierPerks ?? {}}
        initialThresholds={res.data.tierThresholds}
      />
    </main>
  );
}
