import Link from "next/link";
import { apiGet } from "@/lib/api";
import { Card } from "@/components/ui/Card";

interface ShopStatus {
  connected: boolean;
  visitCount: number;
  clientCount: number;
}

export default async function OnboardingDonePage() {
  const res = await apiGet<ShopStatus>("/api/shops/me");
  const status = res.data;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5">
      {/* Light auto-refresh while backfill imports history */}
      {status?.connected && (status.visitCount ?? 0) === 0 && (
        // eslint-disable-next-line @next/next/no-head-element
        <meta httpEquiv="refresh" content="4" />
      )}
      <p className="text-center text-xs uppercase tracking-[0.2em] text-muted">
        Step 3 of 3
      </p>
      <h1 className="mb-2 mt-2 text-center font-display text-3xl tracking-tight">
        You&apos;re all set
      </h1>
      <Card className="mt-4 flex flex-col items-center gap-4 p-8 text-center">
        {!status?.connected ? (
          <p className="text-sm text-muted">
            Acuity isn&apos;t connected yet. You can connect it anytime from your
            dashboard settings.
          </p>
        ) : status.visitCount === 0 ? (
          <>
            <div className="h-2 w-full overflow-hidden rounded-full bg-charcoal-700">
              <div className="skeleton h-full w-1/3 rounded-full bg-gold/40" />
            </div>
            <p className="text-sm text-muted">
              Importing your appointment history… this can take a minute.
            </p>
          </>
        ) : (
          <p className="text-sm text-emerald-soft">
            Imported {status.clientCount} clients and {status.visitCount} visits.
          </p>
        )}
        <Link
          href="/dashboard"
          className="w-full rounded-full bg-gold px-5 py-3 text-sm font-semibold text-charcoal shadow-glow hover:bg-gold-muted"
        >
          Go to dashboard
        </Link>
      </Card>
    </main>
  );
}
