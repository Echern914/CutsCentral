"use client";

import type { GroupPlanResult } from "./actions";

/**
 * The party, as the SERVER laid it out.
 *
 * 🔴 EVERY NUMBER HERE CAME BACK FROM THE API. Not one time, duration or price
 * is computed in the browser. Doing the arithmetic locally would be a second
 * implementation of the shop's duration and price rules, free to drift from
 * the one that actually writes the appointments - and the customer would be
 * confirming against the wrong one.
 *
 * Shared by the review step and the confirmation screen so the customer sees
 * the identical layout before and after booking.
 */

/** `4000` -> "$40". Whole dollars where possible, because prices usually are. */
export function money(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

function timeOf(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function groupDateLabel(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(iso));
}

export function GroupSequence({
  plan,
  timezone,
}: {
  plan: GroupPlanResult;
  timezone: string;
}) {
  return (
    <div className="rounded-2xl border border-subtle bg-charcoal-800/60">
      <ul className="divide-y divide-white/5">
        {plan.members.map((m) => (
          <li key={m.position} className="flex items-baseline gap-3 p-4">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold text-offwhite">
                {m.firstName}
              </span>
              <span className="block truncate text-sm text-muted">{m.serviceName}</span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block whitespace-nowrap text-sm text-offwhite">
                {timeOf(m.startsAt, timezone)}
                <span className="text-muted"> – {timeOf(m.endsAt, timezone)}</span>
              </span>
              <span className="block text-sm text-muted">
                {/* A service with no price set is not a service that is free. */}
                {m.priceCents === null ? "Priced in shop" : money(m.priceCents)}
              </span>
            </span>
          </li>
        ))}
      </ul>

      <div className="flex items-baseline justify-between border-t border-subtle p-4">
        <span className="font-semibold text-offwhite">Total</span>
        <span className="text-right">
          <span className="block font-semibold text-offwhite">
            {money(plan.totalPriceCents)}
            {/* 🔴 Never fold an unpriced service into the number as zero. */}
            {plan.unpricedCount > 0 && (
              <span className="text-muted">
                {" "}
                + {plan.unpricedCount} priced in shop
              </span>
            )}
          </span>
          <span className="block text-sm text-muted">
            {plan.totalDurationMin} min in total
          </span>
        </span>
      </div>

      {/* 🔴 NOT A DEPOSIT. Group bookings are pay-at-the-shop only - the API
          refuses a party outright for any shop that collects at booking - so
          there is never anything to take now, and saying otherwise would be
          inventing a charge. */}
      <p className="border-t border-subtle px-4 py-3 text-sm text-muted">
        Pay at the shop.
      </p>
    </div>
  );
}
