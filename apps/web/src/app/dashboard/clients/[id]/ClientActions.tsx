"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/ui/Toast";
import {
  bonusPunchAction,
  nudgeClientAction,
  redeemAction,
  toggleOptOutAction,
} from "../../actions";
import { recordPromoUseAction } from "../../promotions/actions";

export interface RedeemableReward {
  id: string;
  name: string;
  emoji: string | null;
  punchCost: number;
  affordable: boolean;
}

export function ClientActions({
  clientId,
  rewardsUrl,
  optedOut,
  hasPhone,
  rewards,
  promotions,
}: {
  clientId: string;
  rewardsUrl: string;
  optedOut: boolean;
  hasPhone: boolean;
  rewards: RedeemableReward[];
  promotions: { id: string; title: string }[];
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [nudged, setNudged] = useState(false);
  const [redeemedName, setRedeemedName] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [promoPickerOpen, setPromoPickerOpen] = useState(false);
  const [isOptedOut, setIsOptedOut] = useState(optedOut);
  const canNudge = !isOptedOut && hasPhone;
  const affordable = rewards.filter((r) => r.affordable);

  function copy() {
    navigator.clipboard
      ?.writeText(rewardsUrl)
      .then(() => toast("Rewards link copied", "success"))
      .catch(() => toast("Couldn't copy link", "error"));
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={copy}
        className="rounded-full border border-subtle px-4 py-2 text-xs text-muted hover:bg-charcoal-700"
      >
        Copy rewards link
      </button>

      <button
        disabled={!canNudge || pending || nudged}
        onClick={() =>
          startTransition(async () => {
            const r = await nudgeClientAction(clientId);
            if (r.ok) { setNudged(true); toast("Nudge sent", "success"); }
            else toast("Could not send nudge", "error");
          })
        }
        title={canNudge ? "" : "Opted out or no phone"}
        className="rounded-full border border-gold/50 px-4 py-2 text-xs font-medium text-gold hover:bg-gold/10 disabled:opacity-50"
      >
        {nudged ? "Nudge sent" : pending ? "…" : "Nudge now"}
      </button>

      <button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await toggleOptOutAction(clientId, !isOptedOut);
            if (r.ok) {
              setIsOptedOut(!isOptedOut);
              toast(!isOptedOut ? "Client opted out" : "Client opted back in", "success");
            } else toast("Could not update", "error");
          })
        }
        className="rounded-full border border-subtle px-4 py-2 text-xs text-muted hover:bg-charcoal-700 disabled:opacity-50"
      >
        {isOptedOut ? "Opt back in" : "Opt out"}
      </button>

      <button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await bonusPunchAction(clientId, 1);
            if (r.ok) toast("Bonus punch added", "success");
            else toast("Could not add punch", "error");
          })
        }
        className="rounded-full border border-subtle px-4 py-2 text-xs text-muted hover:bg-charcoal-700 disabled:opacity-50"
      >
        +1 punch
      </button>

      {affordable.length > 0 && !redeemedName && (
        <div className="relative">
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className="rounded-full bg-gold px-4 py-2 text-xs font-semibold text-charcoal hover:bg-gold-muted"
          >
            Redeem reward{affordable.length > 1 ? ` (${affordable.length})` : ""}
          </button>
          {pickerOpen && (
            <div className="absolute right-0 z-10 mt-2 w-64 rounded-2xl border border-subtle bg-charcoal-800 p-2 shadow-glow-sm">
              <p className="px-2 pb-1.5 pt-1 text-[10px] uppercase tracking-wide text-muted">
                Pick the reward to redeem
              </p>
              {affordable.map((reward) => (
                <button
                  key={reward.id}
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const r = await redeemAction(clientId, reward.id);
                      setPickerOpen(false);
                      if (r.ok) {
                        setRedeemedName(reward.name);
                        toast(`${reward.name} redeemed`, "success");
                      } else toast("Could not redeem", "error");
                    })
                  }
                  className="flex w-full items-center justify-between gap-2 rounded-xl px-2 py-2 text-left text-sm text-offwhite hover:bg-charcoal-700 disabled:opacity-50"
                >
                  <span className="truncate">
                    {reward.emoji ? `${reward.emoji} ` : ""}
                    {reward.name}
                  </span>
                  <span className="shrink-0 text-xs text-gold">
                    −{reward.punchCost}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {redeemedName && (
        <span className="text-xs text-emerald-soft">{redeemedName} redeemed</span>
      )}

      {promotions.length > 0 && (
        <div className="relative">
          <button
            onClick={() => setPromoPickerOpen((v) => !v)}
            className="rounded-full border border-subtle px-4 py-2 text-xs text-muted hover:bg-charcoal-700"
          >
            Promo used…
          </button>
          {promoPickerOpen && (
            <div className="absolute right-0 z-10 mt-2 w-64 rounded-2xl border border-subtle bg-charcoal-800 p-2 shadow-glow-sm">
              <p className="px-2 pb-1.5 pt-1 text-[10px] uppercase tracking-wide text-muted">
                Which promo did they use?
              </p>
              {promotions.map((promo) => (
                <button
                  key={promo.id}
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const r = await recordPromoUseAction(promo.id, clientId);
                      setPromoPickerOpen(false);
                      if (r.ok) toast("Promo use recorded", "success");
                      else toast("Could not record", "error");
                    })
                  }
                  className="w-full truncate rounded-xl px-2 py-2 text-left text-sm text-offwhite hover:bg-charcoal-700 disabled:opacity-50"
                >
                  {promo.title}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
