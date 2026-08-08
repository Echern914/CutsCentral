import { PLANS } from "@chairback/config/constants";

/**
 * The diamond: a small plan chip on a feature the shop's plan doesn't include.
 * Renders the PLAN NAME, deliberately nothing else — no price, no "Upgrade",
 * no link — so the same badge is App Store 3.1.1-safe in the native shell and
 * usable from server and client trees alike (no hooks).
 *
 * Two visual weights, mirroring the billing page's own chips: Premium is the
 * soft gold tint, Premium AI is the solid gold gradient (the "Most powerful"
 * treatment). The names come from PLANS so a rename never strands a badge.
 */
export function PlanBadge({ tier }: { tier: "pro" | "pro_ai" }) {
  const name = PLANS[tier].name;
  const styles =
    tier === "pro_ai"
      ? "bg-gold-gradient font-semibold text-charcoal"
      : "bg-gold/15 text-gold";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${styles}`}
    >
      <DiamondIcon />
      {name}
    </span>
  );
}

/** Small gem outline, house-style inline SVG (same conventions as LockIcon). */
function DiamondIcon() {
  return (
    <svg
      className="h-2.5 w-2.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 3h12l4 6-10 12L2 9Z" />
      <path d="M2 9h20" />
      <path d="m9 3 3 6 3-6" />
    </svg>
  );
}
