import Link from "next/link";
import { redirect } from "next/navigation";
import { APP_NAME } from "@chairback/config/constants";
import { getMe } from "@/lib/me";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { logoutAction } from "../(auth)/actions";
import { DashboardNavLinks } from "./_components/DashboardNav";
import { ShopSwitcher } from "./_components/ShopSwitcher";
import { TrialBanner } from "./_components/TrialBanner";

/** Shared dashboard chrome: sticky glass top nav with brand, links, sign out. */
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
          <DashboardNavLinks isAdmin={isAdmin} rewardsEnabled={rewardsEnabled} />
          {shops.length > 1 && (
            <ShopSwitcher shops={shops} activeShopId={activeShopId} />
          )}
          <form action={logoutAction} className="shrink-0">
            <button className="rounded-full border border-subtle px-3.5 py-1.5 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite">
              Sign out
            </button>
          </form>
        </nav>
      </header>
      {/* Hidden inside the native app: it links to Stripe billing (App Store 3.1.1). */}
      <HideInNativeApp>
        <TrialBanner />
      </HideInNativeApp>
      {children}
    </div>
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
