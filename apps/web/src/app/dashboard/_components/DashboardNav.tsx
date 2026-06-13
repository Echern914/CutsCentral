"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const LINKS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/clients", label: "Clients" },
  { href: "/dashboard/rewards", label: "Rewards" },
  { href: "/dashboard/promotions", label: "Promos" },
  { href: "/dashboard/site", label: "Page" },
  { href: "/dashboard/nudges", label: "Nudges" },
  { href: "/dashboard/billing", label: "Billing" },
] as const;

/** Pill nav links with active-route highlighting. */
export function DashboardNavLinks() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-1 overflow-x-auto whitespace-nowrap">
      {LINKS.map((l) => {
        const active =
          l.href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors sm:px-4 sm:text-sm",
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
