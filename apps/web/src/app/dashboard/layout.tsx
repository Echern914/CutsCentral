import type { ReactNode } from "react";
import { resolveHref, type SeatRole } from "@chairback/config/features";
import Link from "next/link";
import { redirect } from "next/navigation";
import { APP_NAME } from "@chairback/config/constants";
import { getMe } from "@/lib/me";
import { getTermsStatus, termsGateShows } from "@/lib/terms";
import { TermsGate } from "@/components/legal/TermsGate";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import { VocabProvider } from "@/components/VocabProvider";
import { featureLocks, getBillingSummary } from "@/lib/billing";
import { collectNotificationSignals } from "@/lib/notificationSignals";
import { getPlatformNotices } from "@/lib/platformNotices";
import { getStripeAlert } from "@/lib/stripeAlert";
import { PullToRefresh } from "@/components/PullToRefresh";
import { ThemeSync } from "@/components/ThemeSync";
import { PREPAINT_SCRIPT } from "@/lib/theme";
import { APP_INSET_SCRIPT } from "@/lib/appSafeArea";
import { logoutAction } from "../(auth)/actions";
import { DashboardNavInline, DashboardTabBar } from "./_components/DashboardNav";
import { DashboardSidebar } from "./_components/DashboardSidebar";
import { AppBottomInset } from "./_components/AppBottomInset";
import { AskButton } from "./_components/AskButton";
import { ShopMark } from "./_components/ShopMark";
import { DemoBanner } from "./_components/DemoBanner";
import { FeatureSearch } from "./_components/FeatureSearch";
import { NotificationBell } from "./_components/NotificationBell";
import { PlatformNoticeBanner } from "./_components/PlatformNoticeBanner";
import { StripeAlertBanner } from "./_components/StripeAlertBanner";
import { ShopSwitcher } from "./_components/ShopSwitcher";
import { TrialBanner } from "./_components/TrialBanner";
import { getOnboardingState } from "@/app/onboarding/state";
import { setupBrief, setupComplete } from "@chairback/config/onboarding";
import { HelpSeatSync } from "@/components/help/helpSeat";

/**
 * Shared dashboard chrome (Studio redesign, 2026-11-16):
 *  - phones: a flat top bar (shop, "Search or ask", bell, account) and a flat
 *    tab bar on the bottom edge;
 *  - tablets: the same top bar with the five tabs inline;
 *  - computers: a left sidebar carries the shop, the tabs, the shop's main
 *    pages, Help, the account and sign out; the top bar keeps search and bell.
 *
 * There is no floating chat button on the dashboard: "Search or ask" opens the
 * Assistant panel (components/help/openAssistant.ts).
 *
 * The tab bar is mounted at the root of this tree, NOT inside <header>, so no
 * header style (a filter or transform) can ever become the containing block of
 * the fixed bar.
 */
export default async function DashboardLayout({
  children,
}: {
  // Imported `ReactNode`, not the global `React.` namespace: this repo resolves
  // @types/react from two places, and mixing the two forms makes the resulting
  // ReactNode types mutually unassignable at any component boundary.
  children: ReactNode;
}) {
  // The Terms read rides alongside /me, not after it: one round trip. It
  // never throws, and any failure is null = no gate (lib/terms.ts).
  const [me, terms] = await Promise.all([getMe(), getTermsStatus()]);
  // The edge middleware only checks the cookie EXISTS, not that it's still valid.
  // A stale/revoked session (e.g. token minted before a tokenVersion bump) keeps
  // the cookie but 401s every API call - which otherwise dead-ends each child
  // page on its own error state. Catch it once here, for the whole dashboard, and
  // send them to log back in (a fresh login mints a current-version token).
  if (me.status === 401) redirect("/login");
  // No current Terms + Privacy agreement on record (Google/Apple signup, an
  // invited team member, everyone from before the agreement was recorded):
  // the "Before you continue" screen INSTEAD of the dashboard - nothing below
  // renders or fetches until they agree. Demo sessions never see it. A failed
  // read shows the dashboard (fail open: never lock a barber out mid-day).
  if (termsGateShows(terms, { demo: me.data?.demo ?? false })) {
    return (
      <div className="min-h-dvh">
        <script dangerouslySetInnerHTML={{ __html: PREPAINT_SCRIPT }} />
        <ThemeSync theme={me.data?.theme ?? "light"} />
        <TermsGate previouslyAgreed={terms?.acceptedVersion != null} />
      </div>
    );
  }
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
  // The seat itself, for the registry. `barberOnly` above answers a LAYOUT
  // question (how many tabs); this answers an ACCESS one, and conflating them
  // is what hid every owner-only destination from owners.
  const seatRole: SeatRole = (me.data?.shopRole ?? "OWNER") as SeatRole;
  // A shop switcher whenever there is somewhere else to go: several owned
  // shops, or a team seat alongside (or instead of) a shop of their own. A
  // one-shop owner with no team never sees it.
  const shops = me.data?.shops ?? [];
  const teams = me.data?.teams ?? [];
  const activeShopId = me.data?.activeShopId ?? null;
  const switcher = shops.length + teams.length > 1;
  // The name the chrome shows: the shop being worked in, else the first one.
  const shopName =
    [...shops, ...teams].find((s) => s.id === activeShopId)?.name ?? shops[0]?.name ?? teams[0]?.name ?? null;
  const demo = me.data?.demo ?? false;
  // Sign out lives in the More sheet and the sidebar now. A demo session gets
  // none: the demo ribbon has its own exit, and logoutAction on the shared demo
  // account would end every other visitor's session (DemoBanner.tsx).
  const signOutAction = demo ? undefined : logoutAction;
  const assistantHref = resolveHref("assistant", { role: seatRole });
  // Which premium features render locked (diamond badges). NO_LOCKS for
  // trialing/subscribed/comped shops, billing-off installs, demo, and employee
  // seats (403 on /api/billing) — see lib/billing.ts. Employee seats skip the
  // fetch entirely: it can only 403 for them.
  //
  // What the header bell shows. Derived per render from counts that already
  // exist — nothing is stored, and every source fails silently, so an employee
  // seat or a lapsed shop gets a quiet bell rather than a broken header.
  // A new shop still setting up sees one thing asking for its attention - the
  // setup checklist on the home page (Eric, 2026-10-16: no interruptions). So
  // until clients can book: no trial banner (unless the trial is nearly over)
  // and no go-live count on the bell. The owner's alone; memoized per request.
  //
  // 🔴 TOGETHER, not one after the other: nothing is sent to the phone until
  // this layout finishes, and in the app that wait is a blank page. Billing and
  // setup don't depend on each other, so they cost one round trip, not two.
  //
  // Platform status notices ride the same round trip, for EVERY seat. The
  // helper never throws and turns any failure into "no notices", so an older
  // API or a blip costs a missing banner, never the dashboard.
  //
  // The Stripe account's health rides it too, for the seats that can act on
  // it (the route is manager-only) - read from the Shop's mirrored columns, so
  // it costs one row, never a Stripe call. Fails quiet like the notices.
  const [billing, setup, platformNotices, stripeAlert] = await Promise.all([
    barberOnly ? Promise.resolve(null) : getBillingSummary(),
    seatRole === "OWNER" && !me.data?.demo ? getOnboardingState() : Promise.resolve(null),
    getPlatformNotices(),
    barberOnly || demo ? Promise.resolve(null) : getStripeAlert(),
  ]);
  const locks = barberOnly || billing === null ? undefined : featureLocks(billing);
  const settingUp = Boolean(setup && !setupComplete(setup.facts));
  const bellSignals = await collectNotificationSignals({
    barberOnly,
    premiumAiLocked: Boolean(locks?.premiumAi || locks?.noReceptionist),
    settingUp,
  });
  const navProps = {
    isAdmin,
    rewardsEnabled,
    affiliateProgramEnabled,
    barberOnly,
    role: seatRole,
    locks,
    signOutAction,
  };
  return (
    <div className="min-h-dvh lg:flex">
      {/* Apply the stored theme BEFORE first paint (a light-mode barber must
          never flash dark on a hard load), then sync the API's answer - the
          server value wins so the choice follows the account to new devices. */}
      <script dangerouslySetInnerHTML={{ __html: PREPAINT_SCRIPT }} />
      <ThemeSync theme={me.data?.theme ?? "light"} />
      {/* The iPhone home-indicator gap, which env() cannot report inside the
          iOS app (lib/appSafeArea.ts). The script sets it before the tab bar
          below is painted; AppBottomInset repeats it after a client-side
          navigation, which never runs inline scripts. */}
      <script dangerouslySetInnerHTML={{ __html: APP_INSET_SCRIPT }} />
      <AppBottomInset />
      {/* Swipe down at the top of any dashboard page to reload - the phone
          (and the iOS shell especially) has no refresh button. */}
      <PullToRefresh />
      <DashboardSidebar
        {...navProps}
        shopName={shopName}
        shops={shops}
        teams={teams}
        activeShopId={activeShopId}
        userName={me.data?.name ?? null}
        avatarUrl={me.data?.avatarUrl ?? null}
        demo={demo}
      />
      <div className="min-w-0 flex-1">
      <header className="sticky top-0 z-20 border-b border-subtle bg-charcoal">
        <nav
          aria-label="Top"
          className="mx-auto flex h-14 w-full max-w-6xl items-center gap-1 px-2 sm:h-16 sm:gap-2 sm:px-4 lg:max-w-none lg:px-6"
        >
          {/* Which shop. On a computer the sidebar shows it, so this hides at
              `lg`. On a tablet only the mark shows, to leave room for the
              tabs; a switcher stays, because it is the only way between shops. */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:flex-none lg:hidden">
            <Link
              href="/dashboard"
              aria-label={`${shopName ?? APP_NAME}, home`}
              className="flex h-11 min-w-[44px] shrink-0 items-center justify-center rounded-lg"
            >
              <ShopMark name={shopName} />
            </Link>
            {switcher ? (
              <div className="flex min-w-0 flex-1 sm:w-40 sm:flex-none">
                <ShopSwitcher shops={shops} teams={teams} activeShopId={activeShopId} wide />
              </div>
            ) : (
              <span className="min-w-0 truncate text-[15px] font-semibold text-offwhite sm:hidden">
                {shopName ?? APP_NAME}
              </span>
            )}
          </div>
          <DashboardNavInline {...navProps} />
          <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
            {barberOnly ? (
              assistantHref && <AskButton assistantHref={assistantHref} />
            ) : (
              <FeatureSearch
                locks={locks}
                role={seatRole}
                rewardsEnabled={rewardsEnabled} affiliateProgramEnabled={affiliateProgramEnabled}
              />
            )}
            {/* Shown for EVERY seat, unlike search: readiness answers for an
                employee too, and "what needs me" is the one thing a barber-only
                dashboard should still surface. */}
            <NotificationBell
              signals={bellSignals}
              whatsNew={me.data?.whatsNew ?? null}
              demo={demo}
              notices={platformNotices}
            />
            {/* Personal account page; on a computer it sits at the foot of the
                sidebar instead. Hidden for read-only demo sessions (shared
                account). Deliberately NOT hidden in the native app: App Store
                5.1.1(v) requires in-app account deletion to stay reachable, and
                it lives on this page. */}
            {!demo && (
              <Link
                href="/dashboard/account"
                aria-label="Account"
                title="Account"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite lg:hidden"
              >
                {me.data?.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={me.data.avatarUrl}
                    alt=""
                    className="h-7 w-7 rounded-full object-cover"
                  />
                ) : (
                  <PersonMark />
                )}
              </Link>
            )}
          </div>
        </nav>
      </header>
      {/* "We know about it and we're fixing it" - above everything else, for
          every seat: it explains whatever might look broken below it. A client
          component RENDERED here, never called (the 2026-08-31 outage). */}
      <PlatformNoticeBanner notices={platformNotices} demo={me.data?.demo ?? false} />
      {/* The shop's own Stripe account needs them: payouts held, payments
          paused, the account closed, or details due (billing/stripeHealth). */}
      <StripeAlertBanner alert={stripeAlert} />
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
        <TrialBanner settingUp={settingUp} />
      )}
      {/* The Assistant panel answers as THIS seat, and an owner's "how do I
          finish setting up?" from their own setup (components/help/helpSeat). */}
      <HelpSeatSync role={seatRole} setup={setup ? setupBrief(setup.facts) : null} />
      {/* Phones scroll under the tab bar, so the last card needs clearance or
          it sits permanently behind it. The bar is 52px plus the home-indicator
          inset, so budget a little over that; from `sm` up the bar is hidden
          and no padding applies.

          Applies to EVERY seat. An employee gets Home + Assistant, so without
          this their last card would sit behind the bar too. */}
      <div
        className="sm:!pb-0"
        style={{ paddingBottom: "calc(4.5rem + var(--cb-safe-bottom))" }}
      >
        {/* Resolved ONCE on the server here; every client component below reads
            it with useVocab(). NEUTRAL for a shop that has not chosen a type. */}
        <VocabProvider value={vocab}>{children}</VocabProvider>
      </div>
      </div>
      <DashboardTabBar {...navProps} />
    </div>
  );
}

/** Fallback avatar for the account button when the person has no photo set. */
function PersonMark() {
  return (
    <svg
      className="h-6 w-6"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9.5" />
      <circle cx="12" cy="10" r="3" />
      <path d="M6.6 18.4c1.2-1.9 3.1-3 5.4-3s4.2 1.1 5.4 3" />
    </svg>
  );
}
