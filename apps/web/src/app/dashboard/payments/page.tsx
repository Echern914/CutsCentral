import type { Metadata } from "next";
import { apiGet } from "@/lib/api";
import { PaymentsManager } from "./PaymentsManager";
import type { PaymentStatus } from "./actions";

export const metadata: Metadata = { title: "Payments" };

export default async function PaymentsPage() {
  const res = await apiGet<PaymentStatus>("/api/payments/status");
  if (!res.ok || !res.data) {
    return <main className="p-8 text-muted">Could not load your payment settings.</main>;
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Payments</h1>
        <p className="mt-1 text-sm text-muted">
          Let customers pay when they book. Connect your own Stripe account —
          money goes straight to you, and you can switch it off anytime to take
          payment in person.
        </p>
      </header>
      <PaymentsManager initial={res.data} />
    </main>
  );
}
