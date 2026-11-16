"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { flagsOffFor, resolveHref, type SeatRole } from "@chairback/config/features";
import { APP_NAME } from "@chairback/config/constants";
import { cn } from "@/lib/cn";
import { openAssistant } from "@/components/help/openAssistant";
import { MoreSheet } from "./MoreSheet";
import { ShopSwitcher } from "./ShopSwitcher";
import { ShopMark, initials } from "./ShopMark";
import { tabsFor, type NavProps, type Tab } from "./DashboardNav";

/**
 * The dashboard on a computer (`lg` and up): a left sidebar instead of a phone
 * column stretched across the screen. Phones keep the bottom tab bar and
 * tablets the inline row (DashboardNav.tsx); this is hidden below `lg`.
 *
 * Top to bottom: which shop, the same four destinations as the tab bar, the
 * shop's most-used pages, "All features" (the More sheet), then Help, the
 * account and sign out pinned to the bottom.
 *
 * Every route is RESOLVED through the registry for this seat, exactly like the
 * tab bar: an employee sees no Shop section, because every entry in it is
 * withheld from their seat, rather than a list of doors that refuse to open.
 */

interface SidebarProps extends NavProps {
  shopName: string | null;
  shops: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  activeShopId: string | null;
  userName: string | null;
  avatarUrl: string | null;
  demo: boolean;
}

/** The shop's own pages worth one click on a computer. Everything else is in "All features". */
const SHOP_SPECS: { featureId: string; label: string; Icon: Tab["Icon"] }[] = [
  { featureId: "mini-site", label: "Your page", Icon: PageIcon },
  { featureId: "services", label: "Services", Icon: TagIcon },
  { featureId: "punch-cards", label: "Rewards", Icon: GiftIcon },
  { featureId: "team", label: "Team", Icon: TeamIcon },
];

/**
 * The ONE sidebar row to mark as current. Several rows can share a path
 * (Calendar is /dashboard/booking, Services is /dashboard/booking?tab=Services),
 * so the most specific match wins: a row whose query also matches beats one
 * that matches on the path alone.
 */
export function pickActive(hrefs: string[], pathname: string, search: URLSearchParams): string | null {
  let best: string | null = null;
  let bestScore = -1;
  for (const href of hrefs) {
    const [path = "", query = ""] = href.split("#")[0]!.split("?");
    const onPath =
      path === "/dashboard" ? pathname === "/dashboard" : pathname === path || pathname.startsWith(`${path}/`);
    if (!onPath) continue;
    const wanted = [...new URLSearchParams(query)];
    if (wanted.some(([k, v]) => search.get(k) !== v)) continue;
    const score = path.length * 10 + wanted.length;
    if (score > bestScore) {
      best = href;
      bestScore = score;
    }
  }
  return best;
}

export function DashboardSidebar({
  isAdmin = false,
  rewardsEnabled = true,
  affiliateProgramEnabled = false,
  barberOnly = false,
  role: seatRole,
  locks,
  signOutAction,
  shopName,
  shops,
  teams,
  activeShopId,
  userName,
  avatarUrl,
  demo,
}: SidebarProps) {
  const pathname = usePathname() ?? "/dashboard";
  const search = useSearchParams();
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);
  const role: SeatRole = seatRole ?? (barberOnly ? "BARBER" : "OWNER");

  const tabs = useMemo(() => tabsFor(role), [role]);
  const shopLinks = useMemo(() => {
    const flagsOff = flagsOffFor({ rewardsEnabled, affiliateProgramEnabled });
    const out: Tab[] = [];
    for (const spec of SHOP_SPECS) {
      // A rewards-off shop gets no Rewards row, as it gets no Rewards pill.
      if (spec.featureId === "punch-cards" && !rewardsEnabled) continue;
      const href = resolveHref(spec.featureId, { role, flagsOff });
      if (href !== null) out.push({ ...spec, href });
    }
    return out;
  }, [role, rewardsEnabled, affiliateProgramEnabled]);

  const current = pickActive(
    [...tabs, ...shopLinks].map((t) => t.href),
    pathname,
    new URLSearchParams(search?.toString() ?? ""),
  );
  const assistantHref = resolveHref("assistant", { role });
  const switcher = shops.length + teams.length > 1;
  // A page reached through "All features" marks that row, so the sidebar never
  // looks like nothing is on. The account page has its own row below.
  const onAccount = pathname.startsWith("/dashboard/account");
  const elsewhere = current === null && !onAccount;

  return (
    <aside
      aria-label="Dashboard"
      className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col overflow-y-auto border-r border-subtle bg-charcoal px-3 pb-3 pt-3 lg:flex"
    >
      <div className="flex min-h-[44px] items-center gap-2 px-1">
        <ShopMark name={shopName} />
        {switcher ? (
          <ShopSwitcher shops={shops} teams={teams} activeShopId={activeShopId} wide />
        ) : (
          <Link
            href="/dashboard"
            className="flex min-h-[44px] min-w-0 flex-1 items-center rounded-lg px-1 text-sm font-semibold text-offwhite"
          >
            <span className="truncate">{shopName ?? APP_NAME}</span>
          </Link>
        )}
      </div>

      <nav aria-label="Main" className="mt-4 flex flex-col gap-0.5">
        {tabs.map((t) => (
          <SideLink key={t.href} tab={t} active={current === t.href} />
        ))}
      </nav>

      {shopLinks.length > 0 && (
        <>
          <p className="px-3 pb-1.5 pt-5 text-xs font-semibold text-muted">Shop</p>
          <nav aria-label="Shop" className="flex flex-col gap-0.5">
            {shopLinks.map((t) => (
              <SideLink key={t.href} tab={t} active={current === t.href} />
            ))}
          </nav>
        </>
      )}

      <button
        type="button"
        onClick={() => setMoreOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={moreOpen}
        className={cn(itemBase, elsewhere ? itemOn : itemOff, "mt-0.5")}
      >
        <GridIcon className={cn("h-[18px] w-[18px] shrink-0", elsewhere ? "text-offwhite" : "text-muted")} />
        All features
      </button>

      <div className="min-h-6 flex-1" />

      {assistantHref && (
        <button
          type="button"
          onClick={(e) => {
            // The panel when it is listening; the full Assistant page if not.
            if (!openAssistant(undefined, e.currentTarget)) router.push(assistantHref);
          }}
          className={cn(itemBase, itemOff)}
        >
          <HelpIcon className="h-[18px] w-[18px] shrink-0 text-muted" />
          Help
        </button>
      )}

      {/* Hidden for the read-only demo session (shared account). Deliberately
          NOT hidden in the native app: App Store 5.1.1(v) requires in-app
          account deletion to stay reachable, and it lives on this page. */}
      {!demo && (
        <Link
          href="/dashboard/account"
          aria-current={onAccount ? "page" : undefined}
          className={cn(
            "mt-1 flex min-h-[48px] items-center gap-2.5 rounded-lg px-2 transition-colors duration-150 ease-out",
            onAccount ? "bg-charcoal-800 ring-1 ring-inset ring-offwhite/10" : "hover:bg-charcoal-700",
          )}
        >
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
          ) : (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-charcoal-700 text-xs font-semibold text-offwhite">
              {initials(userName) || <PersonIcon className="h-4 w-4" />}
            </span>
          )}
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-sm font-semibold text-offwhite">{userName || "Account"}</span>
            <span className="block text-xs text-muted">Account</span>
          </span>
        </Link>
      )}

      {signOutAction && (
        <form action={signOutAction}>
          <button type="submit" className={cn(itemBase, itemOff, "w-full")}>
            <SignOutIcon className="h-[18px] w-[18px] shrink-0 text-muted" />
            Sign out
          </button>
        </form>
      )}

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
    </aside>
  );
}

const itemBase =
  "flex min-h-[40px] items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors duration-150 ease-out";
const itemOn = "bg-charcoal-800 font-semibold text-offwhite ring-1 ring-inset ring-offwhite/10";
const itemOff = "font-medium text-offwhite/80 hover:bg-charcoal-700 hover:text-offwhite";

function SideLink({ tab, active }: { tab: Tab; active: boolean }) {
  const { Icon } = tab;
  return (
    <Link href={tab.href} aria-current={active ? "page" : undefined} className={cn(itemBase, active ? itemOn : itemOff)}>
      <Icon className={cn("h-[18px] w-[18px] shrink-0", active ? "text-offwhite" : "text-muted")} />
      {tab.label}
    </Link>
  );
}

/* Icons: same stroke style as DashboardNav. */

const strokeProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function PageIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M7 6.5h.01M10 6.5h.01" />
    </svg>
  );
}

function TagIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z" />
      <path d="M7.5 7.5h.01" />
    </svg>
  );
}

function GiftIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M12 8v13M19 12v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8" />
      <path d="M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5" />
    </svg>
  );
}

function TeamIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <circle cx="12" cy="8" r="4" />
      <path d="M5 21v-1a7 7 0 0 1 14 0v1" />
    </svg>
  );
}

function GridIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function HelpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01" />
    </svg>
  );
}

function SignOutIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </svg>
  );
}

function PersonIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...strokeProps}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c0-3.6 3.1-6.2 7-6.2s7 2.6 7 6.2" />
    </svg>
  );
}
