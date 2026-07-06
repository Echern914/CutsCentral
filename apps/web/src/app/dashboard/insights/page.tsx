import type { Metadata } from "next";
import { apiGet } from "@/lib/api";
import { InsightsClient } from "./InsightsClient";

export const metadata: Metadata = { title: "Insights" };

export interface InsightsData {
  weeks: { label: string; visits: number; revenue: number }[];
  services: { name: string; count: number; revenue: number }[];
  totals: {
    visits: number;
    revenue: number;
    avgTicket: number;
    uniqueClients: number;
    newClients: number;
    returningClients: number;
  };
  busiest: { weekday: string | null; counts: number[] };
  loyalty: { punchesEarned: number; punchesRedeemed: number; redemptions: number };
}

export default async function InsightsPage() {
  const res = await apiGet<InsightsData>("/api/insights");
  if (!res.ok || !res.data) {
    return <main className="p-8 text-muted">Could not load your insights.</main>;
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Insights</h1>
        <p className="mt-1 text-sm text-muted">
          How your shop is doing: cuts per week, what people book most, and where
          the money comes from. Revenue counts priced visits only.
        </p>
      </header>
      <InsightsClient initial={res.data} />
    </main>
  );
}
