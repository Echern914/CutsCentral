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
  // Inside the native app, hide the Billing pill: it leads to prices and the
  // Stripe Checkout flow, which the App Store forbids in-app (Guideline 3.1.1).
  // Barbers still manage billing in a browser. `null` (pre-hydration) = show.
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
