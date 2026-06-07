"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/ui/Toast";
import {
  bonusPunchAction,
  nudgeClientAction,
  redeemAction,
  toggleOptOutAction,
} from "../../actions";

export function ClientActions({
  clientId,
  rewardsUrl,
  optedOut,
  hasPhone,
  rewardReady,
  rewardLabel,
}: {
  clientId: string;
  rewardsUrl: string;
  optedOut: boolean;
  hasPhone: boolean;
  rewardReady: boolean;
  rewardLabel: string;
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [nudged, setNudged] = useState(false);
  const [redeemed, setRedeemed] = useState(false);
  const [confirmRedeem, setConfirmRedeem] = useState(false);
  const [isOptedOut, setIsOptedOut] = useState(optedOut);
  const canNudge = !isOptedOut && hasPhone;

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

      {rewardReady && !redeemed && (
        confirmRedeem ? (
          <span className="flex items-center gap-2">
            <span className="text-xs text-offwhite">Redeem {rewardLabel}?</span>
            <button
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const r = await redeemAction(clientId);
                  if (r.ok) { setRedeemed(true); toast("Reward redeemed", "success"); }
                  else toast("Could not redeem", "error");
                })
              }
              className="rounded-full bg-gold px-4 py-2 text-xs font-semibold text-charcoal hover:bg-gold-muted disabled:opacity-50"
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirmRedeem(false)}
              className="rounded-full border border-subtle px-3 py-2 text-xs text-muted hover:bg-charcoal-700"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            onClick={() => setConfirmRedeem(true)}
            className="rounded-full bg-gold px-4 py-2 text-xs font-semibold text-charcoal hover:bg-gold-muted"
          >
            Redeem {rewardLabel}
          </button>
        )
      )}
      {redeemed && <span className="text-xs text-emerald-soft">Redeemed</span>}
    </div>
  );
}
