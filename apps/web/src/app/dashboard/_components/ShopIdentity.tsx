"use client";

import Link from "next/link";
import { Avatar } from "@/components/ui/Avatar";
import { useToast } from "@/components/ui/Toast";

/**
 * The top of the dashboard home: who you are, your link, and the one action
 * that matters.
 *
 * The public link is the point. A barber shares it dozens of times a week, and
 * before this it lived two pages deep (Booking, or the Page editor) — the home
 * screen showed the shop name and nothing you could actually send anyone.
 * Copy is the primary affordance; the arrow opens it so they can see what a
 * client sees.
 */
export function ShopIdentity({
  shopName,
  avatarUrl,
  publicUrl,
  connected,
}: {
  shopName: string;
  avatarUrl?: string | null;
  /** Absolute booking URL, or null when the shop has no slug yet. */
  publicUrl: string | null;
  connected: boolean;
}) {
  const { toast } = useToast();

  function copy() {
    if (!publicUrl) return;
    navigator.clipboard
      ?.writeText(publicUrl)
      .then(() => toast("Booking link copied", "success"))
      .catch(() => toast("Couldn't copy link", "error"));
  }

  // Shown without the scheme: it's read at a glance, not parsed.
  const display = publicUrl?.replace(/^https?:\/\//, "") ?? null;

  return (
    <header className="flex flex-col items-center pt-2 text-center">
      <Avatar name={shopName} src={avatarUrl} size="lg" />
      <h1 className="mt-3 font-display text-3xl tracking-tight">{shopName}</h1>

      {display ? (
        <div className="mt-1.5 flex max-w-full items-center gap-1">
          <button
            type="button"
            onClick={copy}
            title="Copy your booking link"
            className="truncate rounded-full px-2 py-1 text-sm text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite"
          >
            {display}
          </button>
          <a
            href={publicUrl ?? "#"}
            target="_blank"
            rel="noreferrer"
            aria-label="Open your booking page in a new tab"
            className="shrink-0 rounded-full p-1.5 text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite"
          >
            <ExternalMark />
          </a>
        </div>
      ) : (
        // No slug yet (brand-new shop): point at where they set one rather than
        // rendering a dead link.
        <Link
          href="/dashboard/site"
          className="mt-1.5 text-sm text-gold underline-offset-2 hover:underline"
        >
          Pick your booking link →
        </Link>
      )}

      {!connected && (
        <a
          href="/onboarding/connect"
          className="animate-pulse-glow mt-3 inline-flex w-fit items-center gap-2 rounded-full border border-gold/50 bg-gold/10 px-4 py-2 text-xs font-medium text-gold transition-colors duration-150 ease-out hover:bg-gold/20"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-gold" />
          Connect your booking to go live
        </a>
      )}
    </header>
  );
}

function ExternalMark() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 4h6v6M20 4l-8.5 8.5" />
      <path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
    </svg>
  );
}
