"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/ui/Toast";
import {
  bonusPunchAction,
  logVisitAction,
  redeemAction,
  toggleOptOutAction,
} from "../../actions";
import { recordPromoUseAction } from "../../promotions/actions";

export interface RedeemableReward {
  id: string;
  name: string;
  emoji: string | null;
  punchCost: number;
  cardTypeId: string | null;
  affordable: boolean;
}

export interface ClientCard {
  id: string | null; // null = the default card
  name: string;
  emoji: string | null;
  accentColor: string | null;
  balance: number;
}

/**
 * Action row on the client detail page. When the shop has custom punch cards,
 * "Log visit" and "+1 punch" open a card picker (which card gets the punch);
 * with zero custom cards they act immediately, exactly as before cards existed.
 * The nudge button lives in the days-since panel (RebookPanel), not here.
 */
export function ClientActions({
  clientId,
  rewardsUrl,
  optedOut,
  rewards,
  cards,
  promotions,
}: {
  clientId: string;
  rewardsUrl: string;
  optedOut: boolean;
  rewards: RedeemableReward[];
  cards: ClientCard[];
  promotions: { id: string; title: string }[];
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [redeemedName, setRedeemedName] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [visitPickerOpen, setVisitPickerOpen] = useState(false);
  const [punchPickerOpen, setPunchPickerOpen] = useState(false);
  const [promoPickerOpen, setPromoPickerOpen] = useState(false);
  const [isOptedOut, setIsOptedOut] = useState(optedOut);
  // Custom cards exist -> punching needs a "which card?" choice.
  const hasCards = cards.some((c) => c.id !== null);
  const cardName = (id: string | null) => cards.find((c) => c.id === id)?.name ?? "card";
  // Group the redeem list by card (default card first, then the shop's card
  // order) so the picker's section headers read cleanly. Stable sort keeps each
  // card's own reward order.
  const cardOrder = new Map(cards.map((c, i) => [c.id, i]));
  const affordable = rewards
    .filter((r) => r.affordable)
    .sort(
      (a, b) => (cardOrder.get(a.cardTypeId) ?? 0) - (cardOrder.get(b.cardTypeId) ?? 0),
    );

  function copy() {
    navigator.clipboard
      ?.writeText(rewardsUrl)
      .then(() => toast("Rewards link copied", "success"))
      .catch(() => toast("Couldn't copy link", "error"));
  }

  function logVisit(cardTypeId?: string) {
    startTransition(async () => {
      const r = await logVisitAction(clientId, undefined, cardTypeId);
      setVisitPickerOpen(false);
      if (r.ok) toast("Visit logged. Punches added", "success");
      else toast("Could not log visit", "error");
    });
  }

  function bonusPunch(cardTypeId?: string) {
    startTransition(async () => {
      const r = await bonusPunchAction(clientId, 1, cardTypeId);
      setPunchPickerOpen(false);
      if (r.ok) toast("Bonus punch added", "success");
      else toast("Could not add punch", "error");
    });
  }

  /** The shared "which card?" popover for log-visit / +1 punch. */
  function CardPicker({
    label,
    onPick,
  }: {
    label: string;
    onPick: (cardTypeId?: string) => void;
  }) {
    return (
      <div className="absolute right-0 z-10 mt-2 w-64 rounded-2xl border border-subtle bg-charcoal-800 p-2 shadow-glow-sm">
        <p className="px-2 pb-1.5 pt-1 text-[10px] uppercase tracking-wide text-muted">
          {label}
        </p>
        {cards.map((card) => (
          <button
            key={card.id ?? "default"}
            disabled={pending}
            onClick={() => onPick(card.id ?? undefined)}
            className="flex w-full items-center justify-between gap-2 rounded-xl px-2 py-2 text-left text-sm text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
          >
            <span className="truncate">
              {card.emoji ? `${card.emoji} ` : ""}
              {card.name}
            </span>
            <span className="shrink-0 text-xs text-muted">{card.balance}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={copy}
        className="rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700"
      >
        Copy rewards link
      </button>

      <button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await toggleOptOutAction(clientId, !isOptedOut);
            if (r.ok) {
              setIsOptedOut(!isOptedOut);
              toast(!isOptedOut ? "Client opted out" : "Client opted back in", "success");
            } else if (r.error === "sms_stop_locked") {
              toast(
                "This client texted STOP - only they can opt back in (by texting START or from their rewards page)",
                "error",
              );
            } else toast("Could not update", "error");
          })
        }
        className="rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
      >
        {isOptedOut ? "Opt back in" : "Opt out"}
      </button>

      <div className="relative">
        <button
          disabled={pending}
          onClick={() => (hasCards ? setVisitPickerOpen((v) => !v) : logVisit())}
          title="Record a visit that happened outside your booking calendar"
          className="rounded-full border border-gold/50 px-4 py-2 text-xs font-medium text-gold transition-colors duration-150 ease-out hover:bg-gold/10 disabled:opacity-50"
        >
          Log visit
        </button>
        {visitPickerOpen && <CardPicker label="Punch which card?" onPick={logVisit} />}
      </div>

      <div className="relative">
        <button
          disabled={pending}
          onClick={() => (hasCards ? setPunchPickerOpen((v) => !v) : bonusPunch())}
          className="rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
        >
          +1 punch
        </button>
        {punchPickerOpen && <CardPicker label="Add the punch to…" onPick={bonusPunch} />}
      </div>

      {affordable.length > 0 && !redeemedName && (
        <div className="relative">
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className="rounded-full bg-gold px-4 py-2 text-xs font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted"
          >
            Redeem reward{affordable.length > 1 ? ` (${affordable.length})` : ""}
          </button>
          {pickerOpen && (
            <div className="absolute right-0 z-10 mt-2 w-64 rounded-2xl border border-subtle bg-charcoal-800 p-2 shadow-glow-sm">
              <p className="px-2 pb-1.5 pt-1 text-[10px] uppercase tracking-wide text-muted">
                Pick the reward to redeem
              </p>
              {affordable.map((reward, i) => {
                // Group header when the card changes (list is already ordered
                // by card via the API's card-then-sortOrder ordering).
                const prev = affordable[i - 1];
                const showHeader =
                  hasCards && (i === 0 || prev?.cardTypeId !== reward.cardTypeId);
                return (
                  <div key={reward.id}>
                    {showHeader && (
                      <p className="px-2 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-gold/80">
                        {cardName(reward.cardTypeId)}
                      </p>
                    )}
                    <button
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
                      className="flex w-full items-center justify-between gap-2 rounded-xl px-2 py-2 text-left text-sm text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
                    >
                      <span className="truncate">
                        {reward.emoji ? `${reward.emoji} ` : ""}
                        {reward.name}
                      </span>
                      <span className="shrink-0 text-xs text-gold">−{reward.punchCost}</span>
                    </button>
                  </div>
                );
              })}
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
            className="rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700"
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
                  className="w-full truncate rounded-xl px-2 py-2 text-left text-sm text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
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
