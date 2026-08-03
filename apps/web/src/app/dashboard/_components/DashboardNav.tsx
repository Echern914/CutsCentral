"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
  href: string;
  label: string;
  Icon: (props: { className?: string }) => JSX.Element;
}

const TABS: Tab[] = [
  { href: "/dashboard", label: "Home", Icon: HomeIcon },
  { href: "/dashboard/booking", label: "Calendar", Icon: CalendarIcon },
  { href: "/dashboard/clients", label: "Clients", Icon: ClientsIcon },
  { href: "/dashboard/insights", label: "Insights", Icon: InsightsIcon },
];

/** True when the current path belongs to `href`'s section. */
function isActive(pathname: string, href: string): boolean {
  // "/dashboard" would prefix-match every dashboard page, so Home is exact.
  return href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);
}

interface NavProps {
  isAdmin?: boolean;
  rewardsEnabled?: boolean;
}

/**
 * Phones only. MUST be mounted outside the blurred top bar — see the note above
 * about `backdrop-filter` and fixed positioning.
 */
export function DashboardTabBar({ isAdmin = false, rewardsEnabled = true }: NavProps) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = !TABS.some((t) => isActive(pathname, t.href));

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-subtle bg-charcoal-900/95 backdrop-blur sm:hidden"
        // The native shell insets only the TOP edge (SafeAreaView edges={["top"]})
        // and disables automatic content insets, so without this the bar sits
        // under the iOS home indicator. The WebView injects viewport-fit=cover,
        // so env() resolves correctly in-app; on plain web it's simply 0.
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul className="flex items-stretch">
          {TABS.map((t) => (
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
      />
    </>
  );
}

/** Tablet and up: the same five destinations, inline in the top bar. */
export function DashboardNavInline({ isAdmin = false, rewardsEnabled = true }: NavProps) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  // Any page that isn't one of the four tabs was reached THROUGH More, so
  // More carries the active state — the nav never looks like nothing is on.
  const moreActive = !TABS.some((t) => isActive(pathname, t.href));

  return (
    <>
      <div className="hidden items-center gap-1 sm:flex">
        {TABS.map((t) => {
          const active = isActive(pathname, t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "rounded-full px-4 py-1.5 text-sm font-medium transition-colors duration-150 ease-out",
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
            "rounded-full px-4 py-1.5 text-sm font-medium transition-colors duration-150 ease-out",
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

function MoreIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}
