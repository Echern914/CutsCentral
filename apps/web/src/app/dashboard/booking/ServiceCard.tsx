"use client";

import type { ReactNode } from "react";
import {
  NEUTRAL_VOCABULARY,
  type BusinessVocabulary,
} from "@chairback/config/businessTypes";
import { useVocab } from "@/components/VocabProvider";
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
 * glance and the detail is one tap away in Edit.
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

export function ServiceCard({
  name,
  summary,
  selected = false,
  flagged = false,
  flagTitle,
  actions,
}: {
  name: string;
  summary: ServiceSummary;
  /** The service currently open in the editor - lit noticeably brighter. */
  selected?: boolean;
  /** Custom hours: keeps the existing gold star affordance. */
  flagged?: boolean;
  flagTitle?: string;
  actions: ReactNode;
}) {
  const vocab = useVocab();
  return (
    <li
      // Dark ground + a thin gold outline, brighter when this is the service
      // being edited. All three states are the same border WIDTH so nothing
      // shifts by a pixel when one is selected.
      className={cn(
        "rounded-xl border bg-charcoal-800/40 px-4 py-3 transition-colors duration-150 ease-out",
        selected
          ? "border-gold bg-gold/[0.06] shadow-[0_0_0_1px_rgba(212,175,55,0.35)]"
          : "border-gold/25 hover:border-gold/50",
      )}
      aria-current={selected ? "true" : undefined}
    >
      {/* Wraps on a phone: the summary takes the full width and the buttons
          drop underneath, rather than the row scrolling sideways. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        {/* basis-full below sm: on a phone the summary takes the whole width
            and the buttons wrap underneath it. Sharing the row there squeezed
            the text so hard that "30 min · $35 · vari…" was all that fit -
            the barber and the availability, two of the four facts, were
            truncated away entirely. */}
        <div className="min-w-0 flex-1 basis-full sm:basis-auto">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-offwhite">
            {flagged && (
              <>
                <span aria-hidden="true" className="text-gold" title={flagTitle}>
                  ★
                </span>
                <span className="sr-only">Custom hours. </span>
              </>
            )}
            <span className="min-w-0 truncate">{name}</span>
          </p>
          {/* One line of four facts. It WRAPS on a phone (where it owns the
              full width) and truncates from sm up, where it shares the row
              with the buttons. min-w-0 on the parent is what lets truncate
              engage at all inside a flex child. */}
          <p className="mt-1 text-xs text-muted sm:truncate">
            {summary.duration}
            {" · "}
            {summary.price}
            {summary.varies && ` · ${summary.varies}`}
            {" · "}
            {summary.barbers}
            {" · "}
            <span className={cn(flagged && "text-gold/90")}>{summary.availability}</span>
          </p>
        </div>
        {/* Always the same three, always in the same order and place. */}
        <div className="flex shrink-0 items-center gap-3">{actions}</div>
      </div>
    </li>
  );
}
