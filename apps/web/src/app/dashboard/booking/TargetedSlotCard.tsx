"use client";

import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * One published targeted slot, collapsed to its name.
 *
 * The list used to print everything on every row: the schedule, the service,
 * the barber, the length, the price, the label, the counts, the next date -
 * all in one run of middot-separated grey text. A shop with a dozen published
 * slots had a wall of near-identical lines, and the one thing that actually
 * tells them apart, the barber's own name for it ("AFTER HOUR HAIRCUT"), was
 * the last item on the line in the smallest type.
 *
 * So: the name, big, and nothing else until you ask. Status and Edit stay out
 * because they are what you came to do; the rest is one tap away.
 *
 * ACCESSIBILITY. The disclosure is a real <button> - Enter and Space work for
 * free, and the browser's focus ring comes with it (never suppressed; see the
 * WCAG conventions this codebase follows). aria-expanded says which way it is,
 * aria-controls names the panel, and the panel is not rendered at all when
 * collapsed so a screen reader never walks hidden content.
 *
 * 🔑 THE ROW ACTIONS ARE SIBLINGS OF THE BUTTON, NOT CHILDREN. A checkbox or an
 * "Edit" nested inside the disclosure button would be invalid (a button may not
 * contain interactive content), and clicking either would also toggle the card.
 */
export function TargetedSlotCard({
  title,
  subtitle,
  status,
  open,
  onToggle,
  leading,
  actions,
  children,
  className,
}: {
  /** The barber's name for this slot, or a sensible stand-in - never empty. */
  title: string;
  /** One short line kept visible while collapsed (e.g. "next Fri 9:00 PM"). */
  subtitle?: string;
  /** Active/inactive at a glance. */
  status?: { label: string; tone: "open" | "booked" | "muted" };
  open: boolean;
  onToggle: () => void;
  /** Rendered left of the disclosure, OUTSIDE it (a bulk-select checkbox). */
  leading?: ReactNode;
  /** Rendered right of the disclosure, OUTSIDE it (Edit / Turn off). */
  actions?: ReactNode;
  /** The detail block. Only mounted while open. */
  children?: ReactNode;
  className?: string;
}) {
  const panelId = useId();

  return (
    <li className={cn("rounded-xl border border-subtle", open && "border-gold/40", className)}>
      {/* items-start, not items-center: with a subtitle the actions should sit
          against the top of the block, and on a phone they wrap under it. */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
        {leading}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={panelId}
          // min-w-0 so a long label truncates instead of pushing the actions
          // off a narrow screen - the "zoomed in" bug this codebase has hit
          // before is exactly a missing min-w-0 on a flex child.
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-offwhite">
              {title}
            </span>
            {subtitle && (
              <span className="mt-0.5 block truncate text-[11px] text-muted">
                {subtitle}
              </span>
            )}
          </span>
          <Chevron open={open} />
        </button>
        {status && (
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
              status.tone === "booked" && "bg-emerald-soft/15 text-emerald-soft",
              status.tone === "open" && "bg-gold/15 text-gold",
              status.tone === "muted" && "bg-charcoal-700 text-muted",
            )}
          >
            {status.label}
          </span>
        )}
        {actions && (
          <span className="flex shrink-0 items-center gap-3">{actions}</span>
        )}
      </div>
      {open && (
        <div id={panelId} className="border-t border-subtle px-4 py-2.5">
          {children}
        </div>
      )}
    </li>
  );
}

/** A gold caret that points down when closed and up when open. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={cn(
        "mt-0.5 h-4 w-4 shrink-0 text-muted transition-transform duration-150 ease-out",
        open && "-rotate-180 text-gold",
      )}
    >
      <path
        d="M6 9l6 6 6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
