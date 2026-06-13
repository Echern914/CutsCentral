"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/ui/Toast";
import { setCompAccessAction } from "./actions";

/** Per-row switch to grant/revoke free full access for a shop. */
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

  return (
    <button
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const next = !comped;
          const r = await setCompAccessAction(shopId, next);
          if (r.ok) {
            setComped(next);
            toast(
              next ? `${shopName} now has free access` : `Free access removed from ${shopName}`,
              "success",
            );
          } else {
            toast("Could not update access", "error");
          }
        })
      }
      className={
        comped
          ? "rounded-full bg-gold px-3 py-1 text-xs font-semibold text-charcoal hover:bg-gold-muted disabled:opacity-50"
          : "rounded-full border border-subtle px-3 py-1 text-xs text-muted hover:bg-charcoal-700 disabled:opacity-50"
      }
    >
      {pending ? "…" : comped ? "Comped ✓" : "Comp free"}
    </button>
  );
}
