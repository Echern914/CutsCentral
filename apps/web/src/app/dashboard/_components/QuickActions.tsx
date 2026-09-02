"use client";

import Link from "next/link";
import { useState } from "react";
import { resolveHref, flagsOffFor } from "@chairback/config/features";
import { useToast } from "@/components/ui/Toast";
import { ShareBookingDialog } from "./ShareBookingDialog";

/**
 * The home screen's action block: ONE primary button, then three secondary
 * shortcuts.
 *
 * The old home had no primary action at all — it opened straight into a stack
 * of analytics cards, so the most common intent ("put someone in the book")
 * required navigating away first. The hierarchy here is the point: the filled
 * gold button is the only thing on the page that looks like that, so it reads
 * as *the* thing to do.
 */
export function QuickActions({
  rewardsEnabled,
  affiliateProgramEnabled,
  bookUrl,
  shopName,
}: {
  rewardsEnabled: boolean;
  affiliateProgramEnabled: boolean;
  /** Absolute public booking URL; null until the shop picks a slug. */
  bookUrl: string | null;
  shopName: string;
}) {
  const { toast } = useToast();
  const [sharing, setSharing] = useState(false);

  // Registry, not literals. These four tiles pointed at routes typed by hand,
  // which is how the rewards tile learned its own rewards-off rule instead of
  // reading the `rewardsEnabled` flag the entries already declare.
  // 🔴 No `?? "/dashboard/..."` fallbacks. A fallback route here would be a
  // second copy of the registry's answer, and a silent one - it would paper
  // over exactly the drift this change exists to remove. A tile the registry
  // withholds is simply not drawn.
  const ctx = { flagsOff: flagsOffFor({ rewardsEnabled, affiliateProgramEnabled }) };
  const bookHref = resolveHref("appointments", ctx);
  const clientsHref = resolveHref("clients", ctx);
  const siteHref = resolveHref("mini-site", ctx);
  // A rewards-off shop has no rewards page (it redirects), so the registry
  // withholds it and the slot shows Promos instead - the nearest "bring people
  // back" tool every shop has.
  const rewardsHref = resolveHref("punch-cards", ctx);
  const promosHref = resolveHref("promotions", ctx);

  return (
    // 🔴 `mb-6` is the fix, not decoration. Every block below this one
    // (SyncHealthBanner, GettingStarted, ConsentSetup) carries `mb-6` and NO
    // top margin, so with nothing on this side the tiles sat flush against
    // whatever came next - reading as one cramped, overlapping slab. This puts
    // the row back on the same 24px rhythm the rest of the page already uses.
    <div className="mb-6 mt-6">
      {bookHref && (
      <Link
        href={bookHref}
        className="flex w-full items-center justify-center gap-2 rounded-full bg-gold px-6 py-3.5 text-sm font-semibold text-charcoal shadow-glow-sm transition-colors duration-200 ease-out hover:bg-gold-muted"
      >
        <CalendarPlusMark />
        Book appointment
      </Link>
      )}

      <div className="mt-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {clientsHref && (
          <Action href={clientsHref} label="Clients">
            <ClientsMark />
          </Action>
        )}
        {rewardsHref ? (
          <Action href={rewardsHref} label="Rewards">
            <RewardsMark />
          </Action>
        ) : (
          promosHref && (
            <Action href={promosHref} label="Promos">
              <PromoMark />
            </Action>
          )
        )}
        {siteHref && (
          <Action href={siteHref} label="Your page">
            <PageMark />
          </Action>
        )}
        {/* No slug yet means no public URL to encode, so the tile points at
            where they pick one instead of opening a dialog with a dead code. */}
        {bookUrl ? (
          <Action onClick={() => setSharing(true)} label="QR code">
            <QrMark />
          </Action>
        ) : (
          siteHref && (
            <Action href={siteHref} label="QR code">
              <QrMark />
            </Action>
          )
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
    </div>
  );
}

/**
 * One shortcut tile. Navigates when given `href`, opens a dialog when given
 * `onClick` - `min-h-16` keeps every tile well past the 44px touch floor and
 * keeps the 2x2 phone grid on an even baseline.
 */
const TILE =
  "flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-2xl " +
  "border border-subtle bg-charcoal-800 py-3 text-xs font-medium " +
  "text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700";

function Action({
  href,
  onClick,
  label,
  children,
}: {
  href?: string;
  onClick?: () => void;
  label: string;
  children: React.ReactNode;
}) {
  const inner = (
    <>
      <span className="text-muted">{children}</span>
      {label}
    </>
  );
  if (href) {
    return (
      <Link href={href} className={TILE}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={TILE}>
      {inner}
    </button>
  );
}

function QrMark() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden {...stroke}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <path d="M13.5 13.5h3v3h-3zM19 13.5h1.5V15M17.5 20.5h3v-3" />
    </svg>
  );
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function CalendarPlusMark() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden {...stroke}>
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M3 10h18M8 3v4M16 3v4M12 13v5M9.5 15.5h5" />
    </svg>
  );
}

function ClientsMark() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden {...stroke}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c0-3.6 3.1-6.2 7-6.2s7 2.6 7 6.2" />
    </svg>
  );
}

function RewardsMark() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden {...stroke}>
      <path d="m12 3.5 2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z" />
    </svg>
  );
}

function PromoMark() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden {...stroke}>
      <path d="M3.5 12.5V5.5a2 2 0 0 1 2-2h7l8 8-9 9z" />
      <circle cx="8.5" cy="8.5" r="1.4" />
    </svg>
  );
}

function PageMark() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden {...stroke}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M3 9h18M7 13h7M7 16.5h4" />
    </svg>
  );
}
