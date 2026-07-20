"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { useIsNativeApp } from "@/lib/useIsNativeApp";

const LINKS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/insights", label: "Insights" },
  { href: "/dashboard/clients", label: "Clients" },
  { href: "/dashboard/rewards", label: "Rewards" },
  { href: "/dashboard/promotions", label: "Promos" },
  { href: "/dashboard/booking", label: "Booking" },
  { href: "/dashboard/payments", label: "Payments" },
  { href: "/dashboard/site", label: "Page" },
  { href: "/dashboard/inbox", label: "Inbox" },
  { href: "/dashboard/requests", label: "Requests" },
  { href: "/dashboard/reviews", label: "Reviews" },
  { href: "/dashboard/nudges", label: "Nudges" },
  { href: "/dashboard/billing", label: "Billing" },
  // /support is a public page (no shop context) - listed here so help is one
  // tap away everywhere, including inside the iOS app (Guideline 1.5).
  { href: "/support", label: "Help" },
] as const;

/** Pill nav links with active-route highlighting. Admins get an extra Admin pill. */
export function DashboardNavLinks({
  isAdmin = false,
  rewardsEnabled = true,
}: {
  isAdmin?: boolean;
  rewardsEnabled?: boolean;
}) {
  const pathname = usePathname();
  // Inside the native app, hide the Billing pill: it leads to the plan
  // comparison and Stripe Checkout, which the App Store forbids in-app
  // (Guideline 3.1.1). Two layers, like HideInNativeApp: the JS filter unmounts
  // it once hydration confirms we're in the app, AND the pill carries
  // `data-native-hide` so the shell's first-paint CSS hides it before hydration
  // — without that backstop the server-rendered pill FLASHED in-app on every
  // cold WebView load (and could be caught in a screenshot). `null`
  // (pre-hydration) keeps it in the list, hidden by that CSS in-app, shown on web.
  const inApp = useIsNativeApp();
  const baseLinks = LINKS.filter(
    (l) =>
      // Rewards-off shop: no Rewards pill (the page itself also redirects).
      (rewardsEnabled || l.href !== "/dashboard/rewards") &&
      (!inApp || l.href !== "/dashboard/billing"),
  );
  const links = isAdmin
    ? [...baseLinks, { href: "/admin", label: "Admin" } as const]
    : baseLinks;
  return (
    <div className="flex items-center gap-1 overflow-x-auto whitespace-nowrap">
      {links.map((l) => {
        const active =
          l.href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            // First-paint backstop: the shell hides `[data-native-hide]` before
            // hydration, so the Billing pill never flashes in-app (3.1.1).
            data-native-hide={l.href === "/dashboard/billing" ? "" : undefined}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors duration-150 ease-out sm:px-4 sm:text-sm",
              active
                ? "bg-gold/15 text-gold"
                : "text-muted hover:bg-charcoal-700 hover:text-offwhite",
            )}
          >
            {l.label}
          </Link>
        );
      })}
    </div>
  );
}
