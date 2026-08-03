import Link from "next/link";
import { redirect } from "next/navigation";
import { APP_NAME } from "@chairback/config/constants";
import { getMe } from "@/lib/me";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { logoutAction } from "../(auth)/actions";
import { DashboardNavInline, DashboardTabBar } from "./_components/DashboardNav";
import { DemoBanner } from "./_components/DemoBanner";
import { FeatureSearch } from "./_components/FeatureSearch";
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
  children: React.ReactNode;
}) {
  const me = await getMe();
  // The edge middleware only checks the cookie EXISTS, not that it's still valid.
  // A stale/revoked session (e.g. token minted before a tokenVersion bump) keeps
  // the cookie but 401s every API call - which otherwise dead-ends each child
  // page on its own error state. Catch it once here, for the whole dashboard, and
  // send them to log back in (a fresh login mints a current-version token).
  if (me.status === 401) redirect("/login");
  const isAdmin = me.data?.isAdmin ?? false;
  // Rewards-off shops get no Rewards nav pill (default true so a transient /me
  // failure never hides a paying shop's tab).
  const rewardsEnabled = me.data?.rewardsEnabled ?? true;
  // An employee seat: no nav (their app is one screen), and no feature search
  // (every result is a manager page that would 403). Defaults to false so a
  // transient /me failure never strips an owner's chrome.
  const barberOnly = me.data?.shopRole === "BARBER";
  // Multi-shop managers get a shop switcher; a normal single-shop barber never
  // sees it (list has one entry).
  const shops = me.data?.shops ?? [];
  const activeShopId = me.data?.activeShopId ?? null;
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 px-4">
        <nav className="glass mx-auto mt-3 flex w-full max-w-6xl items-center justify-between gap-2 rounded-full px-4 py-2.5 sm:px-5">
          <Link href="/dashboard" className="flex shrink-0 items-center gap-2">
            <ScissorsMark />
            <span className="hidden font-display text-sm tracking-tight sm:inline">
              {APP_NAME}
            </span>
          </Link>
          <DashboardNavInline isAdmin={isAdmin} rewardsEnabled={rewardsEnabled} barberOnly={barberOnly} />
          <div className="flex shrink-0 items-center gap-2">
            {!barberOnly && <FeatureSearch />}
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
        /* Hidden inside the native app: it links to Stripe billing (App Store 3.1.1). */
        <HideInNativeApp>
          <TrialBanner />
        </HideInNativeApp>
      )}
      {/* Phones scroll under a fixed tab bar, so the last card needs clearance
          or it sits permanently behind it. ~4.5rem of bar plus the home-indicator
          inset; from `sm` up the bar is hidden and no padding is needed. */}
      <div
        className="sm:!pb-0"
        style={{ paddingBottom: barberOnly ? undefined : "calc(4.5rem + env(safe-area-inset-bottom))" }}
      >
        {children}
      </div>
      <DashboardTabBar isAdmin={isAdmin} rewardsEnabled={rewardsEnabled} barberOnly={barberOnly} />
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
