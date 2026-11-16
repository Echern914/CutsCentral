"use client";

import Link from "next/link";
import { useState } from "react";
import { resolveHref } from "@chairback/config/features";
import { useToast } from "@/components/ui/Toast";
import { ShareBookingDialog } from "./ShareBookingDialog";

/**
 * The top of the dashboard's Today page (Studio redesign): the shop's date,
 * the page name, and the two things a barber does from here most - share the
 * booking link (it gets asked for at the chair) and book someone in.
 *
 * It replaced the centred avatar + shop name + tile grid. The shop's name is
 * in the sidebar and the top bar now, and the tiles (Clients, Rewards, Your
 * page) are one tap away in the tab bar, the sidebar and More.
 */
export function TodayHeader({
  dateLabel,
  bookUrl,
  shopName,
}: {
  /** "Monday, November 16", in the SHOP's timezone (computed by the page). */
  dateLabel: string;
  /** Absolute public booking URL; null until the shop picks a link. */
  bookUrl: string | null;
  shopName: string;
}) {
  const { toast } = useToast();
  const [sharing, setSharing] = useState(false);
  const bookHref = resolveHref("appointments", {});
  const siteHref = resolveHref("mini-site", {});

  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <p className="text-sm text-muted">{dateLabel}</p>
        <h1 className="font-display text-3xl tracking-tight sm:text-4xl">Today</h1>
      </div>
      <div className="flex w-full gap-2 sm:w-auto">
        {bookUrl ? (
          <button
            type="button"
            onClick={() => setSharing(true)}
            className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl border border-subtle-strong bg-charcoal-800 px-4 text-sm font-semibold text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700 sm:flex-none"
          >
            <ShareMark />
            Share link
          </button>
        ) : (
          siteHref && (
            // No slug yet means no public URL to share, so this points at
            // where they pick one instead of opening a dialog with a dead code.
            <Link
              href={siteHref}
              className="flex min-h-[44px] flex-1 items-center justify-center rounded-xl border border-subtle-strong bg-charcoal-800 px-4 text-sm font-semibold text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700 sm:flex-none"
            >
              Pick your booking link
            </Link>
          )
        )}
        {bookHref && (
          <Link
            href={bookHref}
            className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-on-primary transition-colors duration-150 ease-out hover:bg-primary/90 sm:flex-none"
          >
            <PlusMark />
            <span className="sm:hidden">Book</span>
            <span className="hidden sm:inline">Book appointment</span>
          </Link>
        )}
      </div>

      {bookUrl && (
        <ShareBookingDialog
          open={sharing}
          onClose={() => setSharing(false)}
          bookUrl={bookUrl}
          shopName={shopName}
          toast={toast}
        />
      )}
    </header>
  );
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function ShareMark() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden {...stroke}>
      <path d="M12 15V3.5M7.5 8 12 3.5 16.5 8" />
      <path d="M5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5" />
    </svg>
  );
}

function PlusMark() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden {...stroke}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
