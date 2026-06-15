import { redirect } from "next/navigation";
import Link from "next/link";
import { APP_NAME } from "@chairback/config/constants";
import { apiGet } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { LocalDate } from "@/components/ui/LocalDate";
import { CompToggle } from "./CompToggle";
import { AnalyticsSection, type Analytics } from "./Analytics";

export const metadata = { title: `${APP_NAME} Admin` };

interface Metrics {
  billingEnabled: boolean;
  priceMonthlyUsd: number;
  totalShops: number;
  newThisWeek: number;
  paying: number;
  trialing: number;
  comped: number;
  mrrEstimate: number;
  totalClients: number;
  totalVisits: number;
}

interface AdminShop {
  id: string;
  name: string;
  slug: string | null;
  industry: string;
  ownerEmail: string;
  ownerName: string;
  plan: string;
  subscriptionStatus: string;
  compAccess: boolean;
  subscribed: boolean;
  hasAccess: boolean;
  trialEndsAt: string | null;
  clientCount: number;
  visitCount: number;
  createdAt: string;
}

/**
 * Operator portal. Server-gated: the API 404s for non-admins, so a non-admin
 * (or logged-out) request can't read metrics and gets bounced to /dashboard.
 * This page never trusts a client flag - the API session check is the gate.
 */
export default async function AdminPage() {
  const [metricsRes, shopsRes, analyticsRes] = await Promise.all([
    apiGet<Metrics>("/api/admin-portal/metrics"),
    apiGet<{ shops: AdminShop[] }>("/api/admin-portal/shops"),
    apiGet<Analytics>("/api/admin-portal/analytics?days=30"),
  ]);
  if (metricsRes.status === 404 || metricsRes.status === 401) redirect("/dashboard");
  const m = metricsRes.data;
  const shops = shopsRes.data?.shops ?? [];
  const analytics = analyticsRes.data;

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 px-4">
        <nav className="glass mx-auto mt-3 flex w-full max-w-6xl items-center justify-between gap-2 rounded-full px-5 py-2.5">
          <span className="font-display text-sm tracking-tight">
            {APP_NAME} <span className="text-gold">Admin</span>
          </span>
          <Link
            href="/dashboard"
            className="rounded-full border border-subtle px-3.5 py-1.5 text-xs text-muted hover:bg-charcoal-700 hover:text-offwhite"
          >
            Back to dashboard
          </Link>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl px-5 py-8">
        <h1 className="font-display text-2xl tracking-tight">Platform overview</h1>
        <p className="mb-6 mt-1 text-sm text-muted">
          {m?.billingEnabled
            ? "Live billing."
            : "Billing is off (everything free). Paying/MRR will populate once Stripe is configured."}
        </p>

        {m && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Shops" value={m.totalShops} hint={`+${m.newThisWeek} this week`} />
            <Stat label="Paying" value={m.paying} accent />
            <Stat label="Trialing" value={m.trialing} />
            <Stat label="Comped" value={m.comped} />
            <Stat label="Est. MRR" value={`$${m.mrrEstimate}`} accent />
            <Stat label="Clients" value={m.totalClients} hint={`${m.totalVisits} visits`} />
          </div>
        )}

        {analytics && <AnalyticsSection a={analytics} />}

        <h2 className="mb-3 mt-10 font-display text-lg">All shops</h2>
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-subtle text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-4 py-3 font-medium">Shop</th>
                  <th className="px-4 py-3 font-medium">Owner</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Clients</th>
                  <th className="px-4 py-3 font-medium">Joined</th>
                  <th className="px-4 py-3 font-medium">Free access</th>
                </tr>
              </thead>
              <tbody>
                {shops.map((s) => (
                  <tr key={s.id} className="border-b border-subtle/60 last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium text-offwhite">{s.name}</p>
                      <p className="text-xs capitalize text-muted">{s.industry}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-offwhite">{s.ownerName}</p>
                      <p className="text-xs text-muted">{s.ownerEmail}</p>
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill shop={s} />
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {s.clientCount}
                      <span className="text-xs"> · {s.visitCount}v</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">
                      <LocalDate iso={s.createdAt} />
                    </td>
                    <td className="px-4 py-3">
                      <CompToggle shopId={s.id} initial={s.compAccess} shopName={s.name} />
                    </td>
                  </tr>
                ))}
                {shops.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted">
                      No shops yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </main>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <Card className="p-4">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 font-display text-2xl ${accent ? "text-gold" : "text-offwhite"}`}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

function StatusPill({ shop }: { shop: AdminShop }) {
  const [text, cls] = shop.compAccess
    ? ["Comped", "bg-gold/15 text-gold"]
    : shop.subscribed
      ? shop.subscriptionStatus === "past_due"
        ? ["Past due", "bg-danger-soft/15 text-danger-soft"]
        : ["Paying", "bg-emerald-soft/15 text-emerald-soft"]
      : shop.hasAccess
        ? ["Trial", "bg-charcoal-700 text-offwhite"]
        : ["Free", "bg-charcoal-700 text-muted"];
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>{text}</span>
  );
}
