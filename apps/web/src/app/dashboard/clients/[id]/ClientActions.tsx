"use client";

import { useRef, useState, useTransition } from "react";
import { useToast } from "@/components/ui/Toast";
import { apiAnswered } from "@/lib/apiAnswered";
import {
  bonusPunchAction,
  logVisitAction,
  redeemAction,
  rotateRewardsLinkAction,
  toggleOptOutAction,
} from "../../actions";
import { recordPromoUseAction } from "../../promotions/actions";
import { ReasonPicker } from "./ReasonPicker";

/** Why a bonus punch - one tap for the usual reasons, a few words otherwise. */
const BONUS_REASONS = ["Referral", "Made up for a problem", "Promotion", "Loyal regular"];

/** A fresh id for one "Log visit" tap (the API's requestId: 16-64 of [A-Za-z0-9_-]). */
function newTapId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

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
  active: boolean; // archived cards (active=false) can't take new punches
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
  rewardsEnabled = true,
}: {
  clientId: string;
  rewardsUrl: string;
  optedOut: boolean;
  rewards: RedeemableReward[];
  cards: ClientCard[];
  promotions: { id: string; title: string }[];
  /** Rewards-off shop: no punch/redeem actions (Log visit stays - it's history). */
  rewardsEnabled?: boolean;
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [redeemedName, setRedeemedName] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [visitPickerOpen, setVisitPickerOpen] = useState(false);
  const [punchPickerOpen, setPunchPickerOpen] = useState(false);
  const [promoPickerOpen, setPromoPickerOpen] = useState(false);
  // The bonus waiting for its reason: which card it goes on (undefined = the
  // default card), or null when no bonus is in progress.
  const [bonusFor, setBonusFor] = useState<{ cardTypeId?: string } | null>(null);
  const [isOptedOut, setIsOptedOut] = useState(optedOut);
  // Cards you can PUNCH: archived cards are retired and never take a new punch
  // (mirrors auto-routing, which skips inactive cards). The default card is
  // always active. Redeeming an existing balance is unaffected (that's driven by
  // `rewards`, below).
  const punchableCards = cards.filter((c) => c.active);
  // Custom cards exist -> punching needs a "which card?" choice.
  const hasCards = punchableCards.some((c) => c.id !== null);
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

  // 🔴 ONE TAP, ONE VISIT. The id is minted when a Log visit starts and kept
  // until the API gives a definite answer, so a retry after a dropped response
  // (or a second tap while the first is still out) is recognised as the same
  // visit and logged once. `inFlight` covers the gap where `pending` drops
  // while the action is still awaiting.
  const visitTap = useRef<string | null>(null);
  const inFlight = useRef(false);
  // The visit already on the books that day, waiting for the barber to say
  // whether this is a separate one. Holds the card they picked, if any.
  const [onBooks, setOnBooks] = useState<{ message: string; cardTypeId?: string } | null>(null);

  function logVisit(cardTypeId?: string, separateVisit = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    visitTap.current ??= newTapId();
    const requestId = visitTap.current;
    startTransition(async () => {
      try {
        let r: Awaited<ReturnType<typeof logVisitAction>>;
        try {
          r = await logVisitAction(clientId, undefined, cardTypeId, { requestId, separateVisit });
        } catch {
          // 🔴 The PHONE lost the answer (no signal, the app backgrounded) - the
          // visit may well be logged. Same as no answer from the API: keep the
          // id so the next tap is answered from it. Uncaught, this threw the
          // page to "Couldn't load this client" and the id went with it.
          r = { ok: false, status: 0 };
        }
        setVisitPickerOpen(false);
        // No answer, or a 5xx (a gateway 502/504 can follow a visit the API
        // already logged): the outcome is unknown, so keep the id - trying
        // again is the same visit, not a second one (lib/apiAnswered.ts).
        const answered = apiAnswered(r.status);
        if (answered) visitTap.current = null;
        if (r.ok) {
          setOnBooks(null);
          toast(r.replayed ? "Already logged - nothing added" : "Visit logged. Punches added", "success");
        } else if (r.error === "visit_on_books") {
          setOnBooks({
            message: r.message ?? "This client already has a visit on the books that day.",
            cardTypeId,
          });
        } else if (!answered) {
          toast("No answer from ChairBack - tap Log visit again. It won't log twice.", "error");
        } else toast("Could not log visit", "error");
      } finally {
        inFlight.current = false;
      }
    });
  }

  function bonusPunch(reason: string) {
    const target = bonusFor;
    if (!target) return;
    startTransition(async () => {
      const r = await bonusPunchAction(clientId, 1, reason, target.cardTypeId);
      setBonusFor(null);
      if (r.ok) toast("Bonus punch added", "success");
      else toast("Could not add punch", "error");
    });
  }

  /**
   * The shared "which card?" panel for log-visit / +1 punch.
   *
   * 🔴 IN THE ROW'S FLOW, never floated off a button. These panels were
   * `absolute right-0 w-64` on a button near the left edge, so on a phone
   * they ran ~150px off-screen and the card names could not be read. The
   * wrappers are `contents`, so each open panel takes its own full line.
   */
  function CardPicker({
    label,
    onPick,
  }: {
    label: string;
    onPick: (cardTypeId?: string) => void;
  }) {
    return (
      <div className="w-full basis-full rounded-2xl sm:max-w-xs border border-subtle bg-charcoal-800 p-2 shadow-glow-sm">
        <p className="px-2 pb-1.5 pt-1 text-[10px] uppercase tracking-wide text-muted">
          {label}
        </p>
        {punchableCards.map((card) => (
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
        onClick={() => {
          // A real destroy-confirm: rotation kills every link this client was
          // ever texted, including ones they may be using happily right now.
          if (
            !confirm(
              "Replace this client's rewards link? Every link texted to them so far will stop working - they'd recover through the phone-verify page or a fresh text from you.",
            )
          )
            return;
          startTransition(async () => {
            const r = await rotateRewardsLinkAction(clientId);
            if (r.ok) toast("New link minted - old links are dead", "success");
            else toast("Could not replace the link", "error");
          });
        }}
        title="Mint a fresh rewards link and kill every previously texted one (use if a link leaked)"
        className="rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
      >
        New link
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

      <div className="contents">
        <button
          disabled={pending}
          onClick={() => (hasCards ? setVisitPickerOpen((v) => !v) : logVisit())}
          title="Record a visit that happened outside your booking calendar"
          className="rounded-full border border-gold/50 px-4 py-2 text-xs font-medium text-gold transition-colors duration-150 ease-out hover:bg-gold/10 disabled:opacity-50"
        >
          Log visit
        </button>
        {visitPickerOpen && <CardPicker label="Punch which card?" onPick={(id) => logVisit(id)} />}
      </div>

      {/* Its own full-width row, straight under the button that asked - never a
          popover, which on a phone hung off the edge of the screen when the
          button wrapped to the left. */}
      {onBooks && (
        <div
          role="alertdialog"
          aria-label="Visit already on the books"
          className="min-w-0 basis-full rounded-2xl border border-subtle bg-charcoal-800 p-3"
        >
          <p className="text-sm text-offwhite">{onBooks.message}</p>
          <p className="mt-1 text-xs text-muted">
            Only log another if this was a separate visit, or it will earn twice.
          </p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button
              disabled={pending}
              onClick={() => setOnBooks(null)}
              className="rounded-full border border-subtle px-3 py-1.5 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              disabled={pending}
              onClick={() => logVisit(onBooks.cardTypeId, true)}
              className="rounded-full border border-gold/50 px-3 py-1.5 text-xs font-medium text-gold transition-colors duration-150 ease-out hover:bg-gold/10 disabled:opacity-50"
            >
              Log a separate visit
            </button>
          </div>
        </div>
      )}

      {rewardsEnabled && (
        <div className="contents">
          <button
            disabled={pending}
            onClick={() => {
              if (hasCards) setPunchPickerOpen((v) => !v);
              else setBonusFor((v) => (v ? null : {}));
            }}
            className="rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
          >
            +1 punch
          </button>
          {punchPickerOpen && (
            <CardPicker
              label="Add the punch to…"
              onPick={(cardTypeId) => {
                setPunchPickerOpen(false);
                setBonusFor({ cardTypeId });
              }}
            />
          )}
          {bonusFor && (
            <div className="w-full basis-full rounded-2xl sm:max-w-xs border border-subtle bg-charcoal-800 p-3 shadow-glow-sm">
              <ReasonPicker
                prompt={`Why the bonus punch${bonusFor.cardTypeId ? ` on ${cardName(bonusFor.cardTypeId)}` : ""}?`}
                presets={BONUS_REASONS}
                busy={pending}
                onPick={bonusPunch}
                onCancel={() => setBonusFor(null)}
              />
            </div>
          )}
        </div>
      )}

      {rewardsEnabled && affordable.length > 0 && !redeemedName && (
        <div className="contents">
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className="rounded-full bg-gold px-4 py-2 text-xs font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted"
          >
            Redeem reward{affordable.length > 1 ? ` (${affordable.length})` : ""}
          </button>
          {pickerOpen && (
            <div className="w-full basis-full rounded-2xl sm:max-w-xs border border-subtle bg-charcoal-800 p-2 shadow-glow-sm">
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
        <div className="contents">
          <button
            onClick={() => setPromoPickerOpen((v) => !v)}
            className="rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700"
          >
            Promo used…
          </button>
          {promoPickerOpen && (
            <div className="w-full basis-full rounded-2xl sm:max-w-xs border border-subtle bg-charcoal-800 p-2 shadow-glow-sm">
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
