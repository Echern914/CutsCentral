"use client";

import { useTransition } from "react";
import { switchShopAction } from "../actions";

/**
 * Which shop the dashboard is working in: the person's own shop(s), and every
 * team they hold a seat on. Selecting one sets the active-shop cookie and
 * reloads the dashboard onto it. The API re-verifies ownership or the seat, so
 * this can only ever switch between places the person already belongs.
 *
 * Rendered only when there is somewhere else to go (2+ entries in total): a
 * one-shop owner with no team never sees it.
 */
export function ShopSwitcher({
  shops,
  teams = [],
  activeShopId,
  wide = false,
}: {
  shops: { id: string; name: string }[];
  teams?: { id: string; name: string }[];
  activeShopId: string | null;
  /** Fills its row at a 44px height: the sidebar's top row on a computer. */
  wide?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  // Grouped only when both kinds exist - "Your shop" over a single option would
  // be noise for a manager whose shops are all their own.
  const grouped = shops.length > 0 && teams.length > 0;

  return (
    <label className={wide ? "flex min-w-0 flex-1 items-center" : "flex shrink-0 items-center"}>
      <span className="sr-only">Active shop</span>
      <select
        value={activeShopId ?? ""}
        disabled={pending}
        data-qa="shop-switcher"
        onChange={(e) => {
          const id = e.target.value;
          // A transition, not a local flag: the action ends in a redirect, and
          // the transition is what stays pending until that navigation lands.
          startTransition(() => switchShopAction(id));
        }}
        className={
          wide
            ? "min-h-[44px] w-full min-w-0 truncate rounded-lg border border-transparent bg-transparent px-2 text-sm font-semibold text-offwhite outline-none transition-colors duration-150 ease-out hover:bg-charcoal-700 focus-visible:border-subtle-strong disabled:opacity-50"
            : "min-h-[44px] max-w-[9.5rem] truncate rounded-lg border border-subtle-strong bg-charcoal-800 px-3 text-sm text-offwhite outline-none transition-colors duration-150 ease-out hover:bg-charcoal-700 focus:border-gold/50 disabled:opacity-50"
        }
        title="Switch shop"
      >
        {grouped ? (
          <>
            <optgroup label={shops.length > 1 ? "Your shops" : "Your shop"}>
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
            <optgroup label={teams.length > 1 ? "Teams" : "Team"}>
              {teams.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          </>
        ) : (
          [...shops, ...teams].map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))
        )}
      </select>
    </label>
  );
}
