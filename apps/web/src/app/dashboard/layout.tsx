import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { APP_NAME } from "@chairback/config/constants";
import { getMe } from "@/lib/me";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import { VocabProvider } from "@/components/VocabProvider";
import { featureLocks, getBillingSummary } from "@/lib/billing";
import { collectNotificationSignals } from "@/lib/notificationSignals";
import { PullToRefresh } from "@/components/PullToRefresh";
import { ThemeSync } from "@/components/ThemeSync";
import { PREPAINT_SCRIPT } from "@/lib/theme";
import { logoutAction } from "../(auth)/actions";
import { DashboardNavInline, DashboardTabBar } from "./_components/DashboardNav";
import { DemoBanner } from "./_components/DemoBanner";
import { FeatureSearch } from "./_components/FeatureSearch";
import { NotificationBell } from "./_components/NotificationBell";
import { ShopSwitcher } from "./_components/ShopSwitcher";
import { TrialBanner } from "./_components/TrialBanner";

/**
 * Shared dashboard chrome: a slim sticky top bar (brand, search, account, sign
 * out) plus the primary nav, which renders as a bottom tab bar on phones and an
 * inline row in the top bar on wider screens.
 *
 * The tab bar is mounted at the root of this tree, NOT inside <header>: the
 * header's `.glass` sets `backdrop-filter`, which would make the fixed bar
 * position against the nav pill instead of the viewport.
 */
export default async function DashboardLayout({
  children,
}: {
  // Imported `ReactNode`, not the global `React.` namespace: this repo resolves
  // @types/react from two places, and mixing the two forms makes the resulting
  // ReactNode types mutually unassignable at any component boundary.
  children: ReactNode;
}) {
  const me = await getMe();
  // The edge middleware only checks the cookie EXISTS, not that it's still valid.
  // A stale/revoked session (e.g. token minted before a tokenVersion bump) keeps
  // the cookie but 401s every API call - which otherwise dead-ends each child
  // page on its own error state. Catch it once here, for the whole dashboard, and
  // send them to log back in (a fresh login mints a current-version token).
  if (me.status === 401) redirect("/login");
  // Read straight off the same `me` payload the rest of this layout uses - one
  // round trip, already resolved server-side. NEUTRAL when the shop has not
  // chosen a type, or when the API is older than this web deploy.
  const vocab = me.data?.businessType?.vocabulary ?? NEUTRAL_VOCABULARY;
  const isAdmin = me.data?.isAdmin ?? false;
  // Rewards-off shops get no Rewards nav pill (default true so a transient /me
  // failure never hides a paying shop's tab).
  const rewardsEnabled = me.data?.rewardsEnabled ?? true;
  // OFF when unknown - see flagsOffFor in the registry for why the defaults differ.
  const affiliateProgramEnabled = me.data?.affiliateProgramEnabled ?? false;
  // An employee seat: no nav (their app is one screen), and no feature search
  // (every result is a manager page that would 403). Defaults to false so a
  // transient /me failure never strips an owner's chrome.
  const barberOnly = me.data?.shopRole === "BARBER";
  // Multi-shop managers get a shop switcher; a normal single-shop barber never
  // sees it (list has one entry).
  const shops = me.data?.shops ?? [];
  const activeShopId = me.data?.activeShopId ?? null;
  // Which premium features render locked (diamond badges). NO_LOCKS for
  // trialing/subscribed/comped shops, billing-off installs, demo, and employee
  // seats (403 on /api/billing) — see lib/billing.ts. Employee seats skip the
  // fetch entirely: it can only 403 for them.
  const locks = barberOnly ? undefined : featureLocks(await getBillingSummary());
  // What the header bell shows. Derived per render from counts that already
  // exist — nothing is stored, and every source fails silently, so an employee
  // seat or a lapsed shop gets a quiet bell rather than a broken header.
  const bellSignals = await collectNotificationSignals({
    barberOnly,
    premiumAiLocked: locks?.premiumAi ?? false,
  });
  return (
    <div className="min-h-dvh">
      {/* Apply the stored theme BEFORE first paint (a light-mode barber must
          never flash dark on a hard load), then sync the API's answer - the
          server value wins so the choice follows the account to new devices. */}
      <script dangerouslySetInnerHTML={{ __html: PREPAINT_SCRIPT }} />
      <ThemeSync theme={me.data?.theme ?? "dark"} />
      {/* Swipe down at the top of any dashboard page to reload - the phone
          (and the iOS shell especially) has no refresh button. */}
      <PullToRefresh />
      <header className="sticky top-0 z-20 px-4">
        <nav className="glass mx-auto mt-3 flex w-full max-w-6xl items-center justify-between gap-2 rounded-full px-4 py-2.5 sm:px-5">
          <Link href="/dashboard" className="flex shrink-0 items-center gap-2">
            <ScissorsMark />
            <span className="hidden font-display text-sm tracking-tight sm:inline">
              {APP_NAME}
            </span>
          </Link>
          <DashboardNavInline isAdmin={isAdmin} rewardsEnabled={rewardsEnabled} affiliateProgramEnabled={affiliateProgramEnabled} barberOnly={barberOnly} locks={locks} />
          <div className="flex shrink-0 items-center gap-2">
            {!barberOnly && (
              <FeatureSearch
                locks={locks}
                role={barberOnly ? "BARBER" : "MANAGER"}
                rewardsEnabled={rewardsEnabled} affiliateProgramEnabled={affiliateProgramEnabled}
              />
            )}
            {/* Shown for EVERY seat, unlike search: readiness answers for an
                employee too, and "what needs me" is the one thing a barber-only
                dashboard should still surface. */}
            <NotificationBell signals={bellSignals} />
            {shops.length > 1 && (
              <ShopSwitcher shops={shops} activeShopId={activeShopId} />
            )}
            {/* Personal account page. Hidden for read-only demo sessions (shared
                account). Deliberately NOT hidden in the native app: App Store
                5.1.1(v) requires in-app account deletion to stay reachable, and
                it lives on this page. The label collapses on phones so the top
                bar stays a single uncrowded row. */}
            {!me.data?.demo && (
              <Link
                href="/dashboard/account"
                aria-label="Account"
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-subtle px-3 py-1.5 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite sm:px-3.5"
              >
                {me.data?.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={me.data.avatarUrl}
                    alt=""
                    className="h-4 w-4 rounded-full object-cover"
                  />
                ) : (
                  <PersonMark />
                )}
                <span className="hidden sm:inline">Account</span>
              </Link>
            )}
            <form action={logoutAction} className="shrink-0">
              <button className="rounded-full border border-subtle px-3 py-1.5 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite sm:px-3.5">
                Sign out
              </button>
            </form>
          </div>
        </nav>
      </header>
      {/* Read-only demo session: the ribbon replaces the trial banner (a demo
          session has no trial to nag about). */}
      {me.data?.demo ? (
        <div className="px-4">
          <DemoBanner />
        </div>
      ) : (
        /* TrialBanner owns its own 3.1.1 split now: the price-quoting banner
           renders web-only INSIDE it, while a lapsed shop still gets a plain
           factual line in the native app (previously: total silence in-app). */
        <TrialBanner />
      )}
      {/* Phones scroll under the floating tab pill, so the last card needs
          clearance or it sits permanently behind it. The pill is ~3.6rem tall
          and floats 0.625rem above the home-indicator inset, so budget a little
          over the sum; from `sm` up the pill is hidden and no padding applies.

          Applies to EVERY seat now. An employee used to get no tab bar and so
          no padding; they get Home + Assistant, so without this their last card
          would sit behind the pill. */}
      <div
        className="sm:!pb-0"
        style={{ paddingBottom: "calc(5.5rem + env(safe-area-inset-bottom))" }}
      >
        {/* Resolved ONCE on the server here; every client component below reads
            it with useVocab(). NEUTRAL for a shop that has not chosen a type. */}
        <VocabProvider value={vocab}>{children}</VocabProvider>
      </div>
      <DashboardTabBar isAdmin={isAdmin} rewardsEnabled={rewardsEnabled} affiliateProgramEnabled={affiliateProgramEnabled} barberOnly={barberOnly} locks={locks} />
    </div>
  );
}

/** Fallback avatar for the account chip when the barber has no photo set. */
function PersonMark() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c0-3.6 3.1-6.2 7-6.2s7 2.6 7 6.2" />
    </svg>
  );
}

function ScissorsMark() {
  return (
    <svg
      className="h-4 w-4 text-gold"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M8.12 8.12 20 20M14.47 14.48 20 4M8.12 15.88 12 12" />
    </svg>
  );
}
