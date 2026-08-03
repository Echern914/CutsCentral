import { redirect } from "next/navigation";
import { apiGet, apiSend } from "@/lib/api";
import { getMe } from "@/lib/me";
import { StatCards, type Stats } from "./_components/StatCards";
import { TrendsChart, type TrendPoint } from "./_components/TrendsChart";
import { RevenueTrends } from "./_components/RevenueTrends";
import { SweepControl } from "./_components/SweepControl";
import { WinbackPreview } from "./_components/WinbackPreview";
import { AtRiskTable, type AtRiskRow } from "./_components/AtRiskTable";
import { ActivityFeed, type ActivityItem } from "./_components/ActivityFeed";
import { TodayAgenda, type TodayRow } from "./_components/TodayAgenda";
import { Leaderboard, type Leader } from "./_components/Leaderboard";
import { SettingsCard, type ShopSettings } from "./_components/SettingsCard";
import { ClientDemoCard } from "./_components/ClientDemoCard";
import { TourReplayButton } from "./_components/TourReplayButton";
import { SyncHealthBanner } from "./_components/SyncHealthBanner";
import { GettingStarted } from "./_components/GettingStarted";
import { ConsentSetup } from "./_components/ConsentSetup";
import { ShopIdentity } from "./_components/ShopIdentity";
import { QuickActions } from "./_components/QuickActions";
import { DemoTour } from "@/components/tour/DemoTour";

interface ShopMe extends ShopSettings {
  connected: boolean;
  /** URL handle for the public booking page; null until one is picked. */
  slug: string | null;
}

interface SyncStatus {
  connected: boolean;
  liveSyncHealthy: boolean;
  needsRepair: boolean;
  clientCount: number;
  clientsNeedingConsent: number;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: { tour?: string };
}) {
  // Fetch the shop AND the dashboard widgets in one parallel batch instead of
  // gating the whole page on a serial /api/shops/me round-trip first. shops/me
  // doesn't feed the other calls, so there's no dependency to wait on — the old
  // serial hop just added ~1 API round trip to every dashboard open. The
  // redirect/error checks below still run on shopRes before anything renders;
  // on the rare 401/404 the extra widget calls simply also 401 and are dropped.
  // "Today" has to be the SHOP's day, but its timezone only arrives with the
  // agenda response — so ask for a generous UTC window around now (any shop tz
  // is within ±14h of UTC) and narrow to the shop-local day below. One request,
  // no serial hop just to learn the zone.
  const agendaFrom = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  const agendaTo = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
  // Absolute origin for links a barber SHARES (their booking page) or that get
  // texted to clients — those can't be relative.
  const appBase = process.env.APP_BASE_URL ?? "";

  const [shopRes, stats, atRisk, activity, leaderboard, trends, me, sync, agenda] =
    await Promise.all([
      apiGet<ShopMe>("/api/shops/me"),
      apiGet<Stats>("/api/dashboard/stats"),
      apiGet<{ clients: AtRiskRow[] }>("/api/dashboard/at-risk"),
      apiGet<{ items: ActivityItem[] }>("/api/dashboard/activity"),
      apiGet<{ leaders: Leader[] }>("/api/dashboard/leaderboard"),
      apiGet<{ series: TrendPoint[] }>("/api/dashboard/trends"),
      // Memoized: shares the layout's /api/auth/me round-trip for this render.
      getMe(),
      apiGet<SyncStatus>("/api/acuity/oauth/status"),
      apiGet<{ agenda: TodayRow[]; timezone: string }>(
        `/api/booking/agenda?from=${encodeURIComponent(agendaFrom)}&to=${encodeURIComponent(agendaTo)}`,
      ),
    ]);

  if (shopRes.status === 401) redirect("/login");
  if (shopRes.status === 404) redirect("/onboarding");
  // A transient API failure (5xx) must NOT bounce an authenticated barber to
  // the login page - let error.tsx render its "Try again" instead.
  if (!shopRes.ok || !shopRes.data) throw new Error("Failed to load your shop");
  const shop = shopRes.data;

  // Narrow the ±36h agenda window to the shop's OWN calendar day. Comparing
  // en-CA ("YYYY-MM-DD") renderings in the shop tz keeps this off the server's
  // local zone, which would otherwise roll the day over at the wrong midnight.
  const agendaTz = agenda.data?.timezone ?? "UTC";
  const shopDayKey = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: agendaTz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  const todayKey = shopDayKey(new Date().toISOString());
  const todayRows = ((agenda.data?.agenda ?? []) as TodayRow[])
    .filter((r: TodayRow) => shopDayKey(r.start) === todayKey)
    .sort((a: TodayRow, b: TodayRow) => a.start.localeCompare(b.start));

  // Brand-new barber? Arm the interactive dashboard tour right here on their
  // real pages (?tour=1 bootstraps the DemoTour overlay below). Stamp seen
  // FIRST so this fires exactly once; the ?tour guard makes a failed stamp
  // unable to redirect-loop. Default true so a failed /me load never hijacks
  // an existing barber into the tour. Demo sessions are excluded: the shared
  // demo user can't be stamped (read-only), so without the guard every plain
  // /dashboard visit would re-arm the tour on prospects.
  if (
    !(me.data?.welcomeSeen ?? true) &&
    !me.data?.demo &&
    searchParams?.tour === undefined
  ) {
    await apiSend("POST", "/api/auth/welcome-seen");
    redirect("/dashboard?tour=1");
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-5 sm:py-8">
      {/* Barber-side guided tour (prospects via /demo/dashboard; barbers can
          replay it). data-tour anchors: keep in sync with
          packages/config/src/demoTour.ts (DASHBOARD_TOUR_STEPS). */}
      <DemoTour tour="dashboard" route="overview" />

      {/* Identity first, then the one action that matters. Everything below is
          reference material — see the layout note at the bottom of this file. */}
      {/* Capped on wide screens: a full-width primary button across 1280px reads
          as a banner, not a button. The identity block centers with it. */}
      <div className="mx-auto w-full max-w-xl">
        <ShopIdentity
          shopName={shop.name}
          avatarUrl={me.data?.avatarUrl}
          publicUrl={shop.slug ? `${appBase}/book/${shop.slug}` : null}
          connected={shop.connected}
        />
        <QuickActions rewardsEnabled={shop.rewardsEnabled} />
      </div>

      <SyncHealthBanner needsRepair={Boolean(sync.data?.needsRepair)} />

      <GettingStarted
        connected={shop.connected}
        hasClients={(sync.data?.clientCount ?? 0) > 0}
        rewardsEnabled={shop.rewardsEnabled}
      />

      <ConsentSetup needConsentCount={sync.data?.clientsNeedingConsent ?? 0} />

      {/* Today's book, first thing on the page: opening the app should answer
          "who's coming in today?" before any of the analytics below. Rendered
          whenever the agenda call succeeded (an empty day says so itself). */}
      {agenda.ok && <TodayAgenda rows={todayRows} timezone={agendaTz} />}

      {stats.data && (
        <div data-tour="stats">
          <StatCards stats={stats.data} />
        </div>
      )}

      {/* These two carry demo-tour anchors ("at-risk", "activity"), so they stay
          expanded — the spotlight can't anchor to an element inside a closed
          <details>. They're also the two a barber actually reads daily. */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div data-tour="at-risk">
          <AtRiskTable
            rows={atRisk.data?.clients ?? []}
            appBaseUrl={appBase}
          />
        </div>
        <div data-tour="activity">
          <ActivityFeed
            items={activity.data?.items ?? []}
            seeAllHref="/dashboard/activity"
          />
        </div>
      </div>

      {/* Everything past here is reference, not daily use. It used to sit open
          in one long stack — thirteen cards deep, with no hierarchy telling a
          barber which mattered. Collapsed by default it's all still one tap
          away, and the top of the page can be about today. */}
      <Section title="Revenue & trends" hint="How the money is moving">
        {trends.data && <RevenueTrends series={trends.data.series} />}
        {trends.data && <TrendsChart series={trends.data.series} />}
      </Section>

      <Section title="Win back clients" hint="Reach the people who've gone quiet">
        <SweepControl atRiskCount={atRisk.data?.clients?.length ?? 0} />
        <WinbackPreview />
      </Section>

      <Section title="Shop settings" hint="Texting, rewards, and the client demo">
        {shop.rewardsEnabled && (
          <Leaderboard
            leaders={leaderboard.data?.leaders ?? []}
            seeAllHref="/dashboard/leaderboard"
          />
        )}
        <ClientDemoCard />
        <SettingsCard settings={shop} />
        <div>
          <TourReplayButton />
        </div>
      </Section>
    </main>
  );
}

/**
 * A collapsed group of cards. Native <details> on purpose: it works without
 * JavaScript, ships no client bundle from a server component, and gets
 * keyboard and screen-reader behavior from the platform rather than from ARIA
 * we'd have to maintain.
 *
 * Never wrap a `data-tour` anchor in one — a closed <details> hides its
 * content, and the tour spotlight has nothing to measure.
 */
function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <details className="glass group mt-4 rounded-3xl px-4 py-3 sm:px-5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-1">
        <span>
          <span className="font-display text-base tracking-tight">{title}</span>
          <span className="mt-0.5 block text-xs text-muted">{hint}</span>
        </span>
        <span
          aria-hidden
          className="shrink-0 text-muted transition-transform duration-150 ease-out group-open:rotate-180"
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </summary>
      <div className="mt-4 flex flex-col gap-6 pb-2">{children}</div>
    </details>
  );
}
