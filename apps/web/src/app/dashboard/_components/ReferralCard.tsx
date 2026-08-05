import Link from "next/link";

/**
 * The referral program's entry point on the home screen.
 *
 * Without this the whole program was only reachable by opening the More sheet
 * or typing into Ctrl-K — i.e. only by barbers who already knew it existed,
 * which is nobody. A growth feature that has to be searched for doesn't grow
 * anything.
 *
 * Deliberately one compact row rather than the big illustrated banner
 * GlossGenius uses: the home screen was just rebuilt around a single primary
 * action, and a second loud card would undo that. It earns its place by
 * carrying live numbers — "1 month earned" is a reason to look; a static
 * "refer a friend!" tile is wallpaper.
 */
export function ReferralCard({
  earnedMonths,
  pendingCount,
  rewardDays,
}: {
  earnedMonths: number;
  pendingCount: number;
  rewardDays: number;
}) {
  // Three states, in the order a barber actually passes through them.
  const headline =
    earnedMonths > 0
      ? `${earnedMonths} free ${earnedMonths === 1 ? "month" : "months"} earned`
      : "Refer a barber, you both get a month";

  const sub =
    earnedMonths > 0
      ? pendingCount > 0
        ? `${pendingCount} more joined — you earn when they start paying.`
        : "Send your link to another shop and earn another."
      : pendingCount > 0
        ? `${pendingCount} joined — you earn once they start paying.`
        : `They get ${rewardDays} extra days free. You get a month when they start paying.`;

  return (
    <Link
      href="/dashboard/referrals"
      className="glass mt-6 flex items-center gap-4 rounded-3xl px-5 py-4 transition-colors duration-150 ease-out hover:bg-charcoal-700/40"
    >
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold/10 text-gold"
        aria-hidden
      >
        <GiftMark />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-offwhite">{headline}</span>
        <span className="mt-0.5 block text-xs text-muted">{sub}</span>
      </span>
      <span aria-hidden className="shrink-0 text-muted">
        →
      </span>
    </Link>
  );
}

function GiftMark() {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 11h16v9H4z" />
      <path d="M2.5 7.5h19V11h-19zM12 7.5V20" />
      <path d="M12 7.5S10.5 4 8.5 4a2 2 0 0 0 0 3.5zM12 7.5S13.5 4 15.5 4a2 2 0 0 1 0 3.5z" />
    </svg>
  );
}
