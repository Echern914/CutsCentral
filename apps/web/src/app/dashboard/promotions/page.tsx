import type { Metadata } from "next";
import { apiGet } from "@/lib/api";
import { PromotionsManager } from "./PromotionsManager";

export const metadata: Metadata = { title: "Promotions" };

export interface Promo {
  id: string;
  kind: "PERCENT_OFF" | "AMOUNT_OFF" | "FREE_ADDON" | "EXTRA_PUNCHES";
  title: string;
  description: string | null;
  code: string | null;
  percentOff: number | null;
  amountOff: number | null;
  extraPunches: number | null;
  startsAt: string;
  endsAt: string | null;
  active: boolean;
  status: "live" | "scheduled" | "ended" | "off";
  timesUsed: number;
  textsSent: number;
  rebookings: number;
}

export default async function PromotionsPage() {
  const res = await apiGet<{ promotions: Promo[] }>("/api/promos");
  if (!res.ok || !res.data) {
    return <main className="p-8 text-muted">Could not load your promotions.</main>;
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Promotions</h1>
        <p className="mt-1 text-sm text-muted">
          Run your own specials: discounts, freebies, or double-punch windows. Live
          promos show on your clients&apos; rewards page, and you can text them out.
        </p>
      </header>
      <PromotionsManager promotions={res.data.promotions} />
    </main>
  );
}
