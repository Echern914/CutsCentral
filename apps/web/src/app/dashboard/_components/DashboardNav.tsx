"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { resolveHref, type SeatRole } from "@chairback/config/features";
import { cn } from "@/lib/cn";
import { MoreSheet } from "./MoreSheet";

/**
 * Primary navigation. Five fixed destinations — the four a barber opens daily
 * plus "More", which opens the full feature directory (MoreSheet).
 *
 * This replaced a 15-link horizontal scroller that shared one pill with the
 * brand, search, shop switcher, account and sign-out. On a phone that strip was
 * unusable, and since the iOS app is a WebView of these same pages, it WAS the
 * app's navigation. Everything dropped from the strip is still one tap away in
 * the More sheet — nothing was removed, only re-homed.
 *
 * Renders twice, responsively: a bottom tab bar on phones (thumb reach, native
 * feel) and an inline row in the top bar from `sm` up, where a bottom bar would
 * look out of place. Only one is visible at a time.
 *
 * They are TWO exports on purpose, mounted at different points in the layout.
 * The top bar carries `.glass`, whose `backdrop-filter` establishes a
 * containing block for fixed-position descendants — a `position: fixed` bar
 * nested inside it would anchor to the nav pill instead of the viewport. So
 * <DashboardNavInline> goes inside the header and <DashboardTabBar> is mounted
 * at the layout root, outside any blurred ancestor. Each owns its own MoreSheet
 * state; only one is ever visible, so the hidden one's sheet never opens.
 */

interface Tab {
  /** Registry id. The route is RESOLVED, never written here. */
  featureId: string;
  href: string;
  label: string;
  Icon: (props: { className?: string }) => JSX.Element;
}

// Order is deliberate and left-to-right: Home sits in the MIDDLE rather than
// first. On the bottom bar (the phone's real navigation, and the iOS shell's
// only navigation) the centre two slots are the easiest thumb reach, so the
// screens opened most often live there. "More" is appended by the renderers,
// always last.
//
// 🔴 FIVE SLOTS, and Assistant takes the fourth. Insights moves into the More
// sheet rather than becoming a sixth tab: a six-item bar does not fit a 320px
// phone at a 44px touch target, and the sheet is a real destination, not a
// demotion — every non-tab page has lived there since the 5-tab nav landed.
// Assistant earns the slot because it is the only tab that answers "what do I
// do now", which is the question a half-set-up shop opens the app with.
//
// The routes come from the registry so this list cannot drift from the palette,
// the More sheet or the help corpus — the whole reason those three disagreed.
const TAB_SPECS: { featureId: string; label: string; Icon: Tab["Icon"] }[] = [
  { featureId: "online-booking", label: "Calendar", Icon: CalendarIcon },
  { featureId: "clients", label: "Clients", Icon: ClientsIcon },
  { featureId: "home", label: "Home", Icon: HomeIcon },
  { featureId: "assistant", label: "Assistant", Icon: AssistantIcon },
];

/**
 * The tabs a given seat can actually reach, with their routes resolved.
 *
 * An employee seat keeps Home AND Assistant: Assistant is the one place their
 * personal setup tasks and the whole offline help corpus live, and both are
 * things they can act on without a manager. Everything else is manager-gated
 * and would 403, and a nav full of doors that refuse to open reads as a broken
 * app rather than a limited one.
 */
function tabsFor(role: SeatRole): Tab[] {
  const out: Tab[] = [];
  for (const spec of TAB_SPECS) {
    const href = resolveHref(spec.featureId, { role });
    // A tab whose destination the registry withholds is simply not rendered.
    if (href === null) continue;
    out.push({ ...spec, href });
  }
  return out;
}

/** True when the current path belongs to `href`'s section. */
function isActive(pathname: string, href: string): boolean {
  // "/dashboard" would prefix-match every dashboard page, so Home is exact.
  return href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);
}

interface NavProps {
  isAdmin?: boolean;
  rewardsEnabled?: boolean;
  /**
   * True for an employee seat. They used to get NO nav at all, because Home was
   * their only reachable tab. Assistant is the second one — their personal
   * setup tasks and the offline help corpus both live there — so a two-tab bar
   * is now worth rendering.
   */
  barberOnly?: boolean;
  /** Premium lock flags for the More sheet's diamond badges (lib/featureLocks). */
  locks?: import("@/lib/featureLocks").FeatureLocks;
}

/**
 * Phones only. MUST be mounted outside the blurred top bar — see the note above
 * about `backdrop-filter` and fixed positioning.
 */
export function DashboardTabBar({
  isAdmin = false,
  rewardsEnabled = true,
  barberOnly = false,
  locks,
}: NavProps) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const role: SeatRole = barberOnly ? "BARBER" : "MANAGER";
  const tabs = tabsFor(role);
  const moreActive = !tabs.some((t) => isActive(pathname, t.href));

  return (
    <>
      {/* A floating pill rather than an edge-to-edge strip: it reads as a
          control sitting ON the app instead of a band welded to the bottom of
          the screen, and the page visibly scrolls underneath it. */}
      <nav
        aria-label="Primary"
        className="glass fixed inset-x-3 z-30 overflow-hidden rounded-full shadow-ambient-lg sm:hidden"
        // Floats CLEAR of the home indicator instead of padding itself out of
        // the way. The native shell insets only the TOP edge (SafeAreaView
        // edges={["top"]}) and disables automatic content insets, so this offset
        // has to include the inset itself — otherwise the pill would sit ON the
        // indicator rather than above it. The WebView injects viewport-fit=cover
        // so env() resolves in-app; on plain web it's simply 0.
        style={{ bottom: "calc(0.625rem + env(safe-area-inset-bottom))" }}
      >
        <ul className="flex items-stretch">
          {tabs.map((t) => (
            <li key={t.href} className="flex-1">
              <TabLink tab={t} active={isActive(pathname, t.href)} />
            </li>
          ))}
          <li className="flex-1">
            <MoreTab active={moreActive} onOpen={() => setMoreOpen(true)} />
          </li>
        </ul>
      </nav>

      <MoreSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        isAdmin={isAdmin}
        rewardsEnabled={rewardsEnabled}
        role={role}
        locks={locks}
      />
    </>
  );
}

/** Tablet and up: the same five destinations, inline in the top bar. */
export function DashboardNavInline({
  isAdmin = false,
  rewardsEnabled = true,
  barberOnly = false,
  locks,
}: NavProps) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const role: SeatRole = barberOnly ? "BARBER" : "MANAGER";
  const tabs = tabsFor(role);
  // Any page that isn't one of the tabs was reached THROUGH More, so More
  // carries the active state — the nav never looks like nothing is on.
  const moreActive = !tabs.some((t) => isActive(pathname, t.href));

  return (
    <>
      {/* 🔴 `min-w-0` is the fix, not tidying. The bar is three groups in a
          `justify-between` row and the other two are `shrink-0`, so with a
          default `min-width: auto` here nothing could give and the whole PAGE
          overflowed at 768px (774>768). This group yields instead, and scrolls
          its own tabs in the last resort - the page never widens again however
          many tabs or however long their labels get. */}
      <div className="hidden min-w-0 items-center gap-1 overflow-x-auto sm:flex [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => {
          const active = isActive(pathname, t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                // px-3 until there is real room: at 768 the five tabs plus the
                // logo and the account/sign-out cluster were 6px too wide for
                // the viewport. Full padding returns at lg.
                "shrink-0 rounded-full px-3 py-1.5 text-sm font-medium transition-colors duration-150 ease-out lg:px-4",
                active
                  ? "bg-gold/15 text-gold"
                  : "text-muted hover:bg-charcoal-700 hover:text-offwhite",
              )}
            >
              {t.label}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className={cn(
            // Matches the tabs beside it - see the padding note above.
            "shrink-0 rounded-full px-3 py-1.5 text-sm font-medium transition-colors duration-150 ease-out lg:px-4",
            moreActive
              ? "bg-gold/15 text-gold"
              : "text-muted hover:bg-charcoal-700 hover:text-offwhite",
          )}
        >
          More
        </button>
      </div>

      <MoreSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        isAdmin={isAdmin}
        rewardsEnabled={rewardsEnabled}
        role={role}
        locks={locks}
      />
    </>
  );
}

function TabLink({ tab, active }: { tab: Tab; active: boolean }) {
  const { Icon } = tab;
  return (
    <Link
      href={tab.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex flex-col items-center gap-1 px-1 py-2 text-[11px] font-medium transition-colors duration-150 ease-out",
        active ? "text-gold" : "text-muted",
      )}
    >
      <Icon className="h-5 w-5" />
      {tab.label}
    </Link>
  );
}

function MoreTab({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      className={cn(
        "flex w-full flex-col items-center gap-1 px-1 py-2 text-[11px] font-medium transition-colors duration-150 ease-out",
        active ? "text-gold" : "text-muted",
      )}
    >
      <MoreIcon className="h-5 w-5" />
      More
    </button>
  );
}

/* Icons — inline so the bundle gains no dependency. Stroke style matches the
   brand mark in the dashboard layout (1.8 width, round caps). */

const strokeProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function HomeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20h13V9.5" />
    </svg>
  );
}

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

function ClientsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c0-3 2.5-5.2 5.5-5.2s5.5 2.2 5.5 5.2" />
      <path d="M16.5 5.2a3.2 3.2 0 0 1 0 5.9M18 14.9c2 .7 3.5 2.6 3.5 5.1" />
    </svg>
  );
}

function InsightsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <path d="M8 20v-6M13 20V9M18 20v-9" />
    </svg>
  );
}

/** A speech bubble with a spark: help that answers, not a generic robot. */
function AssistantIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <path d="M20.5 12.2c0 3.9-3.8 7-8.5 7a9.8 9.8 0 0 1-2.6-.35L4.5 20.5l1.3-3.3A6.7 6.7 0 0 1 3.5 12.2c0-3.9 3.8-7 8.5-7s8.5 3.1 8.5 7Z" />
      <path d="m12 8.6 1 2.3 2.3 1-2.3 1-1 2.3-1-2.3-2.3-1 2.3-1z" />
    </svg>
  );
}

function MoreIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}
