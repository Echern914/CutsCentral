"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { resolveHref, type SeatRole } from "@chairback/config/features";
import { cn } from "@/lib/cn";
import { MoreSheet } from "./MoreSheet";

/**
 * Primary navigation. Five fixed destinations — the four opened daily plus
 * "More", which opens the full feature directory (MoreSheet).
 *
 * This replaced a 15-link horizontal scroller that shared one pill with the
 * brand, search, shop switcher, account and sign-out. On a phone that strip was
 * unusable, and since the iOS app is a WebView of these same pages, it WAS the
 * app's navigation. Everything dropped from the strip is still one tap away in
 * the More sheet — nothing was removed, only re-homed.
 *
 * Renders three ways, one per screen size, and only one is visible at a time:
 *  - phones: a flat tab bar along the bottom edge (<DashboardTabBar>);
 *  - tablets: an inline row in the top bar (<DashboardNavInline>);
 *  - computers: the left sidebar (DashboardSidebar.tsx), which also carries
 *    the shop's most-used settings.
 *
 * Each owns its own MoreSheet state; only one is ever visible, so the hidden
 * ones' sheets never open. The tab bar is mounted at the layout root, outside
 * the header, so nothing in the header can become its containing block.
 */

export interface Tab {
  /** Registry id. The route is RESOLVED, never written here. */
  featureId: string;
  href: string;
  label: string;
  Icon: (props: { className?: string }) => JSX.Element;
}

// Home leads, as it does in almost every app with a bottom bar: the first slot
// is where people expect "where I start the day" (Studio redesign, approved
// 2026-11-16). "More" is appended by the renderers, always last.
//
// 🔴 FIVE SLOTS, and Insights holds the fourth. It briefly lost that slot to
// Assistant and went into the More sheet; this puts it back, because the two
// are not comparable as tabs. Insights is a DESTINATION you go and read — a
// screen with a shape you scan, several times a week. Assistant answers a
// question you happen to have, which is not a place at all.
//
// So Assistant opens from "Search or ask" in the top bar instead (and Help in
// the sidebar): reachable from EVERY page rather than one, including the pages
// where the question actually occurs to you. See components/help/openAssistant.
//
// A six-item bar was never an option: it does not fit a 320px phone at a 44px
// touch target, which is the floor the whole nav is built to.
//
// The routes come from the registry so this list cannot drift from the palette,
// the More sheet or the help corpus — the whole reason those three disagreed.
const TAB_SPECS: { featureId: string; label: string; Icon: Tab["Icon"] }[] = [
  { featureId: "home", label: "Today", Icon: HomeIcon },
  { featureId: "online-booking", label: "Calendar", Icon: CalendarIcon },
  { featureId: "clients", label: "Clients", Icon: ClientsIcon },
  { featureId: "insights", label: "Insights", Icon: InsightsIcon },
];

/**
 * The tabs a given seat can actually reach, with their routes resolved.
 *
 * An employee seat keeps Home and, where the registry allows it, Assistant.
 * Insights is manager-gated, so `resolveHref` returns null for a BARBER and the
 * tab is simply not drawn — a nav full of doors that refuse to open reads as a
 * broken app rather than a limited one.
 *
 * 🔴 THE EMPLOYEE FALLBACK IS LOAD-BEARING. Assistant is where an employee's
 * own setup tasks and the whole offline help corpus live, and it is the only
 * other thing they can reach. Without it their bar is a single Home tab, so
 * when Insights is withheld the Assistant tab takes that slot back.
 */
export function tabsFor(role: SeatRole): Tab[] {
  const out: Tab[] = [];
  for (const spec of TAB_SPECS) {
    const href = resolveHref(spec.featureId, { role });
    // A tab whose destination the registry withholds is simply not rendered.
    if (href === null) continue;
    out.push({ ...spec, href });
  }

  // A seat that cannot reach Insights gets Assistant in that slot instead of an
  // empty one. For an owner or manager this branch never runs.
  if (!out.some((t) => t.featureId === "insights")) {
    const href = resolveHref("assistant", { role });
    if (href !== null) {
      out.push({ featureId: "assistant", label: "Assistant", Icon: AssistantIcon, href });
    }
  }
  return out;
}

/** True when the current path belongs to `href`'s section. */
export function isActive(pathname: string, href: string): boolean {
  // "/dashboard" would prefix-match every dashboard page, so Home is exact.
  return href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);
}

export interface NavProps {
  isAdmin?: boolean;
  rewardsEnabled?: boolean;
  affiliateProgramEnabled?: boolean;
  /**
   * 🔴 THE SEAT, as /me reports it - not an inference.
   *
   * This used to be `barberOnly ? "BARBER" : "MANAGER"`, which silently
   * demoted every OWNER to MANAGER and so WITHHELD all five owner-only
   * destinations (Affiliates, Plan & billing, Refer a barber, and both
   * payment settings) from the More sheet and the feature search - from the
   * owner, on their own shop. The registry was right; the caller lied to it.
   *
   * Defaults to OWNER when unknown, matching the assistant page and the
   * registry's own documented default: a caller that knows nothing gets the
   * owner-on-web behaviour rather than a quietly reduced product.
   */
  role?: SeatRole;
  /**
   * True for an employee seat. They used to get NO nav at all, because Home was
   * their only reachable tab. Assistant is the second one — their personal
   * setup tasks and the offline help corpus both live there — so a two-tab bar
   * is now worth rendering.
   */
  barberOnly?: boolean;
  /** Premium lock flags for the More sheet's diamond badges (lib/featureLocks). */
  locks?: import("@/lib/featureLocks").FeatureLocks;
  /**
   * The sign-out server action, handed down by the layout so the More sheet
   * can end with "Sign out" (it left the crowded top bar). Absent for a demo
   * session: the demo ribbon has its own exit, and signing out of the shared
   * demo account would end every other visitor's session too.
   */
  signOutAction?: () => Promise<void>;
}

/**
 * Phones only. A flat bar on the bottom edge: white surface, one hairline on
 * top, the current tab in ink and the rest muted.
 */
export function DashboardTabBar({
  isAdmin = false,
  rewardsEnabled = true,
  affiliateProgramEnabled = false,
  barberOnly = false,
  role: seatRole,
  locks,
  signOutAction,
}: NavProps) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const role: SeatRole = seatRole ?? (barberOnly ? "BARBER" : "OWNER");
  const tabs = tabsFor(role);
  const moreActive = !tabs.some((t) => isActive(pathname, t.href));

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-subtle bg-charcoal-800 sm:hidden"
        // The bar owns the home-indicator gap itself. The native shell insets
        // only the TOP edge (SafeAreaView edges={["top"]}) and disables
        // automatic content insets, so without this the labels sit under the
        // indicator. 🔴 NOT env(): the WebView never sets viewport-fit=cover,
        // so env() reads 0 in the app - which is exactly how the labels ended
        // up covered. --cb-safe-bottom carries the app's real gap
        // (lib/appSafeArea.ts) and is plain env() everywhere else.
        style={{ paddingBottom: "var(--cb-safe-bottom)" }}
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
        affiliateProgramEnabled={affiliateProgramEnabled}
        role={role}
        locks={locks}
        signOutAction={signOutAction}
      />
    </>
  );
}

/** Tablets: the same five destinations, inline in the top bar. */
export function DashboardNavInline({
  isAdmin = false,
  rewardsEnabled = true,
  affiliateProgramEnabled = false,
  barberOnly = false,
  role: seatRole,
  locks,
  signOutAction,
}: NavProps) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const role: SeatRole = seatRole ?? (barberOnly ? "BARBER" : "OWNER");
  const tabs = tabsFor(role);
  // Any page that isn't one of the tabs was reached THROUGH More, so More
  // carries the active state — the nav never looks like nothing is on.
  const moreActive = !tabs.some((t) => isActive(pathname, t.href));

  return (
    <>
      {/* 🔴 `min-w-0` is the fix, not tidying. The bar is groups in a row and
          the right-hand cluster is `shrink-0`, so with a default
          `min-width: auto` here nothing could give and the whole PAGE
          overflowed at 768px (774>768). This group yields instead, and scrolls
          its own tabs in the last resort - the page never widens again however
          many tabs or however long their labels get. Hidden from `lg`, where
          the sidebar carries the same destinations. */}
      <div className="hidden min-w-0 items-center gap-0.5 overflow-x-auto sm:flex lg:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => {
          const active = isActive(pathname, t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-[44px] shrink-0 items-center rounded-lg px-3 text-sm transition-colors duration-150 ease-out",
                active
                  ? "bg-charcoal-700 font-semibold text-offwhite"
                  : "font-medium text-muted hover:bg-charcoal-700 hover:text-offwhite",
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
            "flex min-h-[44px] shrink-0 items-center rounded-lg px-3 text-sm transition-colors duration-150 ease-out",
            moreActive
              ? "bg-charcoal-700 font-semibold text-offwhite"
              : "font-medium text-muted hover:bg-charcoal-700 hover:text-offwhite",
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
        affiliateProgramEnabled={affiliateProgramEnabled}
        role={role}
        locks={locks}
        signOutAction={signOutAction}
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
        "flex min-h-[52px] flex-col items-center justify-center gap-0.5 px-1 pb-1 pt-1.5 text-[11px] transition-colors duration-150 ease-out",
        active ? "font-semibold text-offwhite" : "font-medium text-muted",
      )}
    >
      <Icon className="h-6 w-6" />
      <TabLabel>{tab.label}</TabLabel>
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
        "flex min-h-[52px] w-full flex-col items-center justify-center gap-0.5 px-1 pb-1 pt-1.5 text-[11px] transition-colors duration-150 ease-out",
        active ? "font-semibold text-offwhite" : "font-medium text-muted",
      )}
    >
      <MoreIcon className="h-6 w-6" />
      <TabLabel>More</TabLabel>
    </button>
  );
}

/**
 * One line, always. Five tabs on a 320px phone leave each label 56px, which
 * fits the longest one ("Assistant") - but a label that ever wrapped would
 * make its tab taller than the rest, so it shortens with an ellipsis instead.
 */
function TabLabel({ children }: { children: string }) {
  return <span className="block max-w-full truncate leading-tight">{children}</span>;
}

/* Icons — inline so the bundle gains no dependency. One stroke style
   everywhere (1.75 width, round caps), matching the redesign's icon set. */

const strokeProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function HomeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

export function ClientsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

export function InsightsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <path d="M3 3v18h18" />
      <path d="M18 17V9M13 17V5M8 17v-3" />
    </svg>
  );
}

/** A speech bubble with a spark: help that answers, not a generic robot. */
export function AssistantIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <path d="M20.5 12.2c0 3.9-3.8 7-8.5 7a9.8 9.8 0 0 1-2.6-.35L4.5 20.5l1.3-3.3A6.7 6.7 0 0 1 3.5 12.2c0-3.9 3.8-7 8.5-7s8.5 3.1 8.5 7Z" />
      <path d="m12 8.6 1 2.3 2.3 1-2.3 1-1 2.3-1-2.3-2.3-1 2.3-1z" />
    </svg>
  );
}

export function MoreIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}
