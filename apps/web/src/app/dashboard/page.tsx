import { redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { StatCards, type Stats } from "./_components/StatCards";
import { TrendsChart, type TrendPoint } from "./_components/TrendsChart";
import { SweepControl } from "./_components/SweepControl";
import { AtRiskTable, type AtRiskRow } from "./_components/AtRiskTable";
import { ActivityFeed, type ActivityItem } from "./_components/ActivityFeed";
import { Leaderboard, type Leader } from "./_components/Leaderboard";
import { SettingsCard, type ShopSettings } from "./_components/SettingsCard";
import { AccountCard } from "./_components/AccountCard";

interface ShopMe extends ShopSettings {
  connected: boolean;
}

export default async function DashboardPage() {
  const shopRes = await apiGet<ShopMe>("/api/shops/me");
  if (shopRes.status === 401) redirect("/login");
  if (shopRes.status === 404) redirect("/onboarding");
  // A transient API failure (5xx) must NOT bounce an authenticated barber to
  // the login page - let error.tsx render its "Try again" instead.
  if (!shopRes.ok || !shopRes.data) throw new Error("Failed to load your shop");
  const shop = shopRes.data;

  const [stats, atRisk, activity, leaderboard, trends, me] = await Promise.all([
    apiGet<Stats>("/api/dashboard/stats"),
    apiGet<{ clients: AtRiskRow[] }>("/api/dashboard/at-risk"),
    apiGet<{ items: ActivityItem[] }>("/api/dashboard/activity"),
    apiGet<{ leaders: Leader[] }>("/api/dashboard/leaderboard"),
    apiGet<{ series: TrendPoint[] }>("/api/dashboard/trends"),
    apiGet<{ name: string; email: string }>("/api/auth/me"),
  ]);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-5 sm:py-8">
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-muted">
            Your shop
          </p>
          <h1 className="font-display text-4xl tracking-tight">{shop.name}</h1>
        </div>
        {!shop.connected && (
          <a
            href="/onboarding/connect"
            className="animate-pulse-glow inline-flex w-fit items-center gap-2 rounded-full border border-gold/50 bg-gold/10 px-4 py-2 text-xs font-medium text-gold transition-colors hover:bg-gold/20"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-gold" />
            Connect Acuity to go live
          </a>
        )}
      </header>

      {stats.data && <StatCards stats={stats.data} />}

      <div className="mt-6">
        <SweepControl atRiskCount={atRisk.data?.clients?.length ?? 0} />
      </div>

      {trends.data && (
        <div className="mt-6">
          <TrendsChart series={trends.data.series} />
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <AtRiskTable
          rows={atRisk.data?.clients ?? []}
          appBaseUrl={process.env.APP_BASE_URL ?? ""}
        />
        <ActivityFeed
          items={activity.data?.items ?? []}
          seeAllHref="/dashboard/activity"
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Leaderboard
          leaders={leaderboard.data?.leaders ?? []}
          seeAllHref="/dashboard/leaderboard"
        />
        <SettingsCard settings={shop} />
      </div>

      <div className="mt-6">
        <AccountCard
          name={me.data?.name ?? ""}
          email={me.data?.email ?? ""}
          shopName={shop.name}
        />
      </div>
    </main>
  );
}
