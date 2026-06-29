"use client";

import { useTransition } from "react";
import { switchShopAction } from "../actions";

/**
 * Active-shop picker for a manager who owns more than one shop. Selecting a shop
 * sets the active-shop cookie (server action) and reloads the dashboard onto that
 * shop. The API re-verifies ownership, so this only ever switches between the
 * user's OWN shops. Rendered only when shops.length > 1 (a normal barber never
 * sees it).
 */
export function ShopSwitcher({
  shops,
  activeShopId,
}: {
  shops: { id: string; name: string }[];
  activeShopId: string | null;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <label className="flex shrink-0 items-center">
      <span className="sr-only">Active shop</span>
      <select
        value={activeShopId ?? ""}
        disabled={pending}
        onChange={(e) => {
          const id = e.target.value;
          startTransition(() => switchShopAction(id));
        }}
        className="max-w-[9.5rem] truncate rounded-full border border-subtle bg-charcoal-800 px-3 py-1.5 text-xs text-offwhite outline-none transition-colors duration-150 ease-out hover:bg-charcoal-700 focus:border-gold/50 disabled:opacity-50"
        title="Switch shop"
      >
        {shops.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}
