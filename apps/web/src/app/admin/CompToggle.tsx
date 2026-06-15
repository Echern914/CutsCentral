"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/ui/Toast";
import { setCompAccessAction } from "./actions";

/**
 * Per-row switch to grant/revoke free full access for a shop. Renders as a
 * sliding toggle: the visual state flips optimistically on click and animates,
 * then rolls back if the server write fails - so the on/off change feels
 * instant and smooth rather than waiting on the round-trip.
 */
export function CompToggle({
  shopId,
  initial,
  shopName,
}: {
  shopId: string;
  initial: boolean;
  shopName: string;
}) {
  const { toast } = useToast();
  const [comped, setComped] = useState(initial);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !comped;
    setComped(next); // optimistic: animate immediately
    startTransition(async () => {
      const r = await setCompAccessAction(shopId, next);
      if (r.ok) {
        toast(
          next ? `${shopName} now has free access` : `Free access removed from ${shopName}`,
          "success",
        );
      } else {
        setComped(!next); // roll back on failure
        toast("Could not update access", "error");
      }
    });
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={comped}
      aria-label={`Free access for ${shopName}`}
      disabled={pending}
      onClick={toggle}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 disabled:opacity-60 ${
        comped ? "bg-gold" : "bg-charcoal-700 border border-subtle"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full shadow-sm transition-[transform,background-color] duration-200 ease-out ${
          comped ? "translate-x-6 bg-charcoal" : "translate-x-1 bg-muted"
        }`}
      />
    </button>
  );
}
