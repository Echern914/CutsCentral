"use client";

import { useId } from "react";
import {
  NEUTRAL_VOCABULARY,
  type BusinessVocabulary,
} from "@chairback/config/businessTypes";
import { cn } from "@/lib/cn";
import { formatPrice } from "@/lib/serviceFields";

/**
 * One service in the Services list.
 *
 * The list was a stack of hairline rows that ran everything together on one
 * line - name, length, price, and then EVERY per-weekday override spelled out
 * ("Sun $55, Mon $55, Tue $55, Wed $55, Thu $55, Fri $60, Sat $60"). Nine
 * services read as one grey paragraph, and on a phone the override list pushed
 * the buttons off the right edge.
 *
 * Now each one is its own card: dark ground, a thin gold outline, the name
 * clear at the top, and one line of summary underneath - how long, how much,
 * who does it, when it's bookable. The overrides are counted, not listed
 * ("varies by day"), because the number of them is the useful signal at a
 * glance and the detail is one tap away on the service's page.
 *
 * Every service gets the same treatment, whatever it is called or however it
 * is configured - a plain haircut and a "VIP Package" are the same shape, so a
 * long menu stays scannable.
 */

/** The four things worth knowing about a service without opening it. */
export interface ServiceSummary {
  /** "30 min". */
  duration: string;
  /** "$35" or "No price set". */
  price: string;
  /**
   * "varies by day" when the length OR the price is not the same every day,
   * or null.
   *
   * One flag rather than a suffix on each, because a service that varies in
   * both used to render "30 min · varies by day · $35 · varies by day" - the
   * same phrase twice in one short line.
   */
  varies: string | null;
  /** "All barbers", "Marcus", "Marcus, Dre", "Marcus, Dre +2". */
  barbers: string;
  /** "Regular hours" or the custom-window summary. */
  availability: string;
}

/**
 * Build the summary line.
 *
 * Pure and exported so it can be tested without a renderer, and so the rule
 * "count the overrides, don't list them" lives in one place.
 */
export function serviceSummary(input: {
  durationMin: number;
  price: number | null;
  priceOverrides?: Record<string, number> | null;
  durationOverrides?: Record<string, number> | null;
  timeOverrides?: unknown[] | null;
  offeredByAll: boolean;
  staffNames: string[];
  /**
   * The shop's words. Passed IN rather than read from a hook so this stays a
   * pure, separately-testable function; omitted means NEUTRAL, which is generic
   * rather than barbershop.
   */
  vocab?: BusinessVocabulary;
  /** hoursWindowsSummary() output, or null when the service is on regular hours. */
  customHours: string | null;
}): ServiceSummary {
  const priceVaries =
    Object.keys(input.priceOverrides ?? {}).length > 0 ||
    (input.timeOverrides ?? []).length > 0;
  const durationVaries =
    Object.keys(input.durationOverrides ?? {}).length > 0 ||
    (input.timeOverrides ?? []).length > 0;

  return {
    duration: `${input.durationMin} min`,
    // "No price set" rather than "$0": a service with no price is not free,
    // it is unpriced, and the booking page shows it without a number.
    price: input.price === null ? "No price set" : formatPrice(input.price),
    varies: priceVaries || durationVaries ? "varies by day" : null,
    barbers: barberLabel(input.offeredByAll, input.staffNames, input.vocab ?? NEUTRAL_VOCABULARY),
    availability: input.customHours ?? "Regular hours",
  };
}

/**
 * Who does it. Two names then a count - a shop with eight providers should not
 * get eight names wrapping onto three lines on a phone.
 */
function barberLabel(
  offeredByAll: boolean,
  names: string[],
  vocab: BusinessVocabulary,
): string {
  if (offeredByAll) return `All ${vocab.providerNounPlural}`;
  if (names.length === 0) return `No ${vocab.providerNoun} assigned`;
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

/**
 * One service on the menu. The WHOLE card is the way in: tap it and the
 * service's own page opens.
 *
 * It used to carry five small links along its right edge (an eye, Edit, Dates,
 * Duplicate, Remove). On a phone they were 16px tall, wrapped under the
 * summary, and Remove sat a thumb's width from Edit. Everything they did now
 * lives on the service's page, as full-height rows; the card just says what
 * the service is.
 */
export function ServiceCard({
  name,
  summary,
  color = null,
  flagged = false,
  flagTitle,
  hidden = false,
  note = null,
  onOpen,
}: {
  name: string;
  summary: ServiceSummary;
  /** The calendar colour as a hex, drawn as a bar; null draws none. */
  color?: string | null;
  /** Custom hours: keeps the existing gold star affordance. */
  flagged?: boolean;
  flagTitle?: string;
  /** Hidden from clients: only the barber can book it. */
  hidden?: boolean;
  /** One short thing worth knowing before opening it ("2 special dates"). */
  note?: string | null;
  onOpen: () => void;
}) {
  const summaryId = useId();
  return (
    <li
      // Dark ground + a thin gold outline, the same on every service.
      className="rounded-xl border border-gold/25 bg-charcoal-800/40 transition-colors duration-150 ease-out hover:border-gold/50"
    >
      <button
        type="button"
        onClick={onOpen}
        // The name alone names the button; the summary is its description, so
        // a screen reader says "Edit Haircut" and then what the service is.
        aria-label={`Edit ${name}`}
        aria-describedby={summaryId}
        className="flex min-h-[64px] w-full items-center gap-3 rounded-xl px-4 py-3 text-left"
      >
        {color && (
          <span
            aria-hidden="true"
            data-testid="service-color-bar"
            className="h-9 w-1 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
        )}
        {/* min-w-0 is what lets the name truncate inside a flex child. */}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-offwhite">
            {flagged && (
              <span aria-hidden="true" className="text-gold" title={flagTitle}>
                ★
              </span>
            )}
            <span className="min-w-0 truncate">{name}</span>
            {hidden && (
              <span
                data-testid="service-hidden-badge"
                className="shrink-0 rounded-full border border-subtle px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted"
              >
                Hidden
              </span>
            )}
          </span>
          {/* One line of four facts. It WRAPS rather than truncating: nothing
              shares the row with it any more, and a cut-off line hid who does
              the service and when. */}
          <span id={summaryId} className="mt-1 block text-xs font-normal text-muted">
            {flagged && <span className="sr-only">Custom hours. </span>}
            {summary.duration}
            {" · "}
            {summary.price}
            {summary.varies && ` · ${summary.varies}`}
            {" · "}
            {summary.barbers}
            {" · "}
            <span className={cn(flagged && "text-gold/90")}>{summary.availability}</span>
          </span>
        </span>
        {note && (
          <span className="shrink-0 rounded-full bg-gold/10 px-2.5 py-1 text-[11px] font-medium text-gold">
            {note}
          </span>
        )}
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-muted"
        >
          <path d="M6 3l5 5-5 5" />
        </svg>
      </button>
    </li>
  );
}
