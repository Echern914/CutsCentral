import type { Metadata } from "next";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { OffersManager } from "./OffersManager";
import type { OffersList } from "./actions";

export const metadata: Metadata = { title: "Offers & codes" };

export default async function OffersPage() {
  const res = await apiGet<OffersList>("/api/offers");
  if (!res.ok || !res.data) {
    return <main className="p-8 text-muted">Could not load your offers.</main>;
  }
  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Offers &amp; codes</h1>
        <p className="mt-1 text-sm text-muted">
          A code takes money off a booking: dollars off, a percent off, or one free service. Make one anyone can
          use, or one for a single client from their page. ChairBack never sends a code for you.
        </p>
        <p className="mt-2 text-sm">
          <Link href="/dashboard/promotions" className="text-gold underline-offset-4 hover:underline">
            Promotions
          </Link>{" "}
          <span className="text-muted">are for specials you show and text out.</span>
        </p>
      </header>
      {res.data.enabled ? (
        <OffersManager list={res.data} />
      ) : (
        <p className="rounded-2xl border border-subtle bg-charcoal-800/40 p-4 text-sm text-muted" data-testid="offers-off">
          Offers &amp; codes isn&apos;t switched on for your shop yet.
        </p>
      )}
    </main>
  );
}
