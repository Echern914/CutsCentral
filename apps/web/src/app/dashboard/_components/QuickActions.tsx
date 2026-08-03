import Link from "next/link";

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
export function QuickActions({ rewardsEnabled }: { rewardsEnabled: boolean }) {
  return (
    <div className="mt-6">
      <Link
        href="/dashboard/booking?tab=Appointments"
        className="flex w-full items-center justify-center gap-2 rounded-full bg-gold px-6 py-3.5 text-sm font-semibold text-charcoal shadow-glow-sm transition-colors duration-200 ease-out hover:bg-gold-muted"
      >
        <CalendarPlusMark />
        Book appointment
      </Link>

      <div className="mt-2.5 grid grid-cols-3 gap-2.5">
        <Action href="/dashboard/clients" label="Clients">
          <ClientsMark />
        </Action>
        {/* A rewards-off shop has no /dashboard/rewards page (it redirects), so
            that slot shows Promos instead — the nearest "bring people back"
            tool that every shop has. */}
        {rewardsEnabled ? (
          <Action href="/dashboard/rewards" label="Rewards">
            <RewardsMark />
          </Action>
        ) : (
          <Action href="/dashboard/promotions" label="Promos">
            <PromoMark />
          </Action>
        )}
        <Action href="/dashboard/site" label="Your page">
          <PageMark />
        </Action>
      </div>
    </div>
  );
}

function Action({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col items-center justify-center gap-1.5 rounded-2xl border border-subtle bg-charcoal-800 py-3 text-xs font-medium text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
    >
      <span className="text-muted">{children}</span>
      {label}
    </Link>
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
