"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { setRewardsEnabledAction } from "./actions";

/**
 * THE rewards on/off switch - the only one in the dashboard.
 *
 * It lives on the page it governs. It used to be a checkbox in the Settings
 * card, where an owner looking at their punch cards never found it, and where a
 * Settings tab opened before a change would post the old value straight back.
 *
 * Off is a promise to clients, not a hint: no punch cards, no reward menu, no
 * tiers, no loyalty messages, no Wallet card. Nothing earned is deleted, so
 * turning it back on picks up exactly where it left off.
 */
export function RewardsSwitch({ on }: { on: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  // 🔴 The server's value wins. This only covers the moment between the tap and
  // the refresh; a useState seeded from the prop alone would ignore every
  // router.refresh() after the first render.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  useEffect(() => setOptimistic(null), [on]);
  const shown = optimistic ?? on;

  function flip() {
    const next = !shown;
    if (
      !next &&
      !window.confirm(
        "Turn rewards off? Your clients won't see punch cards, rewards or tiers anywhere until you turn them back on. Punches they've already earned are kept.",
      )
    ) {
      return;
    }
    setOptimistic(next);
    start(async () => {
      const r = await setRewardsEnabledAction(next);
      if (!r.ok) {
        setOptimistic(null);
        toast("Couldn't change that. Try again.", "error");
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card className="mb-6 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-offwhite">Punch cards &amp; rewards</h2>
          <p className="mt-1 text-sm text-muted">
            {shown
              ? "On. Clients see their punch cards, your reward menu and their tier."
              : "Off. Clients see none of it — no punch cards, rewards, tiers or loyalty messages. Punches already earned are kept."}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={shown}
          aria-label="Punch cards and rewards"
          disabled={pending}
          onClick={flip}
          className={cn(
            "relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ease-out focus-visible:ring-2 focus-visible:ring-gold/50 disabled:opacity-60",
            shown ? "bg-gold" : "border border-subtle bg-charcoal-700",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "inline-block h-4 w-4 transform rounded-full shadow-sm transition-[transform,background-color] duration-200 ease-out",
              shown ? "translate-x-6 bg-charcoal" : "translate-x-1 bg-muted",
            )}
          />
        </button>
      </div>
    </Card>
  );
}
