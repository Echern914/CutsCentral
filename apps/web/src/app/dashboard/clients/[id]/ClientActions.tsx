"use client";

import { useState, useTransition } from "react";
import { nudgeClientAction, redeemAction } from "../../actions";

export function ClientActions({
  clientId,
  rewardsUrl,
  canNudge,
  rewardReady,
  rewardLabel,
}: {
  clientId: string;
  rewardsUrl: string;
  canNudge: boolean;
  rewardReady: boolean;
  rewardLabel: string;
}) {
  const [pending, startTransition] = useTransition();
  const [nudged, setNudged] = useState(false);
  const [redeemed, setRedeemed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmRedeem, setConfirmRedeem] = useState(false);

  function copy() {
    void navigator.clipboard?.writeText(rewardsUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        onClick={copy}
        className="rounded-full border border-subtle px-4 py-2 text-xs text-muted hover:bg-charcoal-700"
      >
        {copied ? "Copied" : "Copy rewards link"}
      </button>

      <button
        disabled={!canNudge || pending || nudged}
        onClick={() =>
          startTransition(async () => {
            const r = await nudgeClientAction(clientId);
            if (r.ok) setNudged(true);
          })
        }
        title={canNudge ? "" : "Opted out or no phone"}
        className="rounded-full border border-gold/50 px-4 py-2 text-xs font-medium text-gold hover:bg-gold/10 disabled:opacity-50"
      >
        {nudged ? "Nudge sent" : pending ? "Sending…" : "Nudge now"}
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
                  if (r.ok) setRedeemed(true);
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
      {redeemed && <span className="text-xs text-emerald-soft">Reward redeemed</span>}
    </div>
  );
}
