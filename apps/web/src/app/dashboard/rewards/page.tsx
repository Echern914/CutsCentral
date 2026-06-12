import type { Metadata } from "next";
import { apiGet } from "@/lib/api";
import { RewardsBuilder } from "./RewardsBuilder";

export const metadata: Metadata = { title: "Rewards" };

export interface LoyaltyConfig {
  punchesPerVisit: number;
  rewards: {
    id: string;
    name: string;
    description: string | null;
    emoji: string | null;
    punchCost: number;
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
  const res = await apiGet<LoyaltyConfig>("/api/loyalty");
  if (!res.ok || !res.data) {
    return <main className="p-8 text-muted">Could not load your rewards setup.</main>;
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Rewards</h1>
        <p className="mt-1 text-sm text-muted">
          Design your own program: what clients can earn, and how fast they earn it.
          Everything here shows up on your clients&apos; rewards page.
        </p>
      </header>
      <RewardsBuilder config={res.data} />
    </main>
  );
}
