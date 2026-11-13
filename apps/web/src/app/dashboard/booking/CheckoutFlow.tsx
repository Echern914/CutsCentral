"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { loadAction } from "@/lib/loadAction";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { useVocab } from "@/components/VocabProvider";
import {
  cancelCheckoutAttemptAction,
  chargeSavedCardAction,
  getCheckoutAction,
  recordCashCheckoutAction,
  settleTapToPayAction,
  startTapToPayAction,
  terminalConnectionTokenAction,
  type CheckoutState,
  type ChargeCardResult,
} from "./actions";
import {
  collectWithPhone,
  nativeTapToPayAvailable,
  requestTapToPayEducation,
} from "./tapToPayBridge";

/**
 * POST-SERVICE CHECKOUT — the screen a barber uses with the customer in front
 * of them, so every rule here is about not taking the wrong money in public.
 *
 * Three steps, and the middle one is not skippable:
 *   review  — who, what, when, and the balance due, which is not editable.
 *   confirm — the exact amount and the exact method, once more, alone on the
 *             screen. Nothing is charged before this is pressed.
 *   result  — what happened, with a reference, and the way back.
 *
 * 🔴 NO METHOD IS PRESELECTED and none fires on being chosen. Choosing a method
 * moves to `confirm`; only `confirm` charges. A barber reaching for the screen
 * must not be able to take someone's money with one stray tap.
 *
 * 🔴 ONE PRESS = ONE requestId, minted when the confirm step opens and reused
 * for every retry of that press. The server replays it rather than charging
 * again, so a double tap, a dropped response and a reloaded WebView are all
 * harmless.
 *
 * 🔴 THE AMOUNT AND THE METHODS COME FROM THE SERVER, re-read whenever this
 * opens. The agenda's idea of the price is a cache; charging against a cache is
 * how a barber confirms one number and the customer is charged another.
 */

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** A fresh handle for one press of a payment button. */
function newRequestId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `req_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

type Step = "review" | "confirm" | "result";
type Choice =
  | { kind: "saved_card" }
  | { kind: "tap_to_pay" }
  | { kind: "cash_other"; method: "cash" | "direct" | "card" | "other" };

/** Why a saved card is unavailable, in words a barber can act on. */
const BLOCKER_COPY: Record<string, string> = {
  no_card: "No card saved for this booking",
  // They agreed, then stopped it from their appointment link.
  consent_withdrawn: "The customer stopped charges to this card",
  card_not_saved: "The saved card is not usable right now",
  // The distinction the whole consent split exists for.
  no_service_consent: "This card was only approved for no-show fees",
  consent_not_for_this_appointment: "This card was approved for a different appointment",
  // The 72-hour post-service window has closed.
  retention_expired: "Too long since this appointment to charge the saved card",
  // The customer agreed to a charge only once the appointment is finished.
  not_finished: "The saved card can be charged once the appointment is done",
  native_not_ready: "Not set up on this device yet",
  disabled: "Not enabled for this shop",
};

/**
 * The saved-card line when it cannot be used. `over_agreed_price` carries a
 * figure: the customer approved the card up to what they booked, and the
 * barber needs that number to explain why the card stops short of the ticket.
 */
function savedCardBlockerCopy(blocker: string, approvedUpToCents?: number | null): string {
  if (blocker === "over_agreed_price") {
    return approvedUpToCents
      ? `The saved card was approved only up to ${money(approvedUpToCents)}. Take the balance another way.`
      : "The saved card was not approved for this price. Take the balance another way.";
  }
  return BLOCKER_COPY[blocker] ?? "Saved card unavailable";
}

// Money taken outside ChairBack. Every one of these RECORDS a payment and
// charges nothing - including `card`, which is a card run on the barber's own
// reader (the original chair checkout always offered it, and a shop that takes
// cards that way must not have to file them under "Other").
const CASH_METHODS = [
  { key: "cash" as const, label: "Cash", hint: "You keep 100%" },
  { key: "direct" as const, label: "Zelle · Venmo · Cash App", hint: "Sent to your handle" },
  { key: "card" as const, label: "Card on your own reader", hint: "Recorded only, not charged here" },
  { key: "other" as const, label: "Other", hint: "Comp, trade, split" },
];

export function CheckoutFlow({
  appointmentId,
  timeZone,
  onDone,
  onBackToAppointment,
  onBookNext,
  reviewExtra,
}: {
  appointmentId: string;
  /** The shop's IANA zone: the appointment's time means nothing in any other. */
  timeZone?: string;
  /** A collection landed: the agenda and the sheet need re-reading. */
  onDone: () => void;
  /** The clear way back to the same appointment. */
  onBackToAppointment: () => void;
  /**
   * Start this client's next booking. Given only where the calendar's booking
   * form is mounted to answer it; absent, the paid screen offers no such
   * button rather than one that does nothing.
   */
  onBookNext?: () => void;
  /**
   * Shown under the methods on the review step only - never beside an open
   * collection or a confirm (the sheet's "Didn't show up? Mark no-show").
   */
  reviewExtra?: React.ReactNode;
}) {
  const [state, setState] = useState<CheckoutState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The website was deployed while this sheet was open (lib/loadAction.ts).
  const [stale, setStale] = useState(false);
  const [step, setStep] = useState<Step>("review");
  const [choice, setChoice] = useState<Choice | null>(null);
  const [outcome, setOutcome] = useState<ChargeCardResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A card saved for no-show fees only: the barber ticks that the customer
  // said yes before Charge works. Cleared whenever the confirm step is left.
  const [clientOk, setClientOk] = useState(false);
  const vocab = useVocab();
  // Whether THIS device can collect contactlessly. Read after mount, never
  // during render: the server render has no `window`, and a value baked into
  // the HTML would be wrong for every viewer of it.
  const [nativeReady, setNativeReady] = useState(false);
  useEffect(() => {
    setNativeReady(nativeTapToPayAvailable());
  }, []);


  /** Minted when confirm opens; every retry of THAT press reuses it. */
  const requestId = useRef<string | null>(null);

  const load = useCallback(async () => {
    const call = await loadAction(() => getCheckoutAction(appointmentId));
    if (!call.ok) {
      if (call.failure === "stale") setStale(true);
      // Still a throw, as it always was: the payment steps that re-read after
      // a collection catch it and say so in their own words.
      throw new Error("checkout_read_failed");
    }
    const res = call.value;
    if (!res.ok || !res.data) {
      setLoadError(res.error ?? "Couldn't load this checkout");
      return;
    }
    setState(res.data);
    setLoadError(null);
  }, [appointmentId]);

  // The first read (and its retry). A throw here - no answer at all, or a
  // stale deployment - used to leave "Loading…" on screen for good.
  const loadOrSayWhy = useCallback(() => {
    void load().catch(() => setLoadError("Couldn't load this checkout"));
  }, [load]);

  useEffect(() => {
    loadOrSayWhy();
  }, [loadOrSayWhy]);

  /**
   * 🔴 ONE FIGURE, AND THE BARBER CANNOT EDIT IT. v1 collects the whole
   * remaining balance or nothing: a lower number is a partial payment or a
   * silent discount, a higher one is over-collection or a tip, and the API
   * refuses all four. A barber who needs a different total edits the PRICE on
   * the appointment, which is an audited change, and comes back here.
   */
  const dueCents = state?.remainingCents ?? null;
  const chargeCents = dueCents ?? 0;

  /**
   * One contactless collection: open the attempt, hand the phone the secret,
   * then ASK THE SERVER what happened.
   *
   * 🔴 THE PHONE'S ANSWER NEVER BECOMES THE RECORD. Whatever the device
   * reports - collected, cancelled, declined, nothing at all - the outcome
   * shown here comes from the settle call, which reads Stripe. A device saying
   * "collected" is a client claiming a payment, and this flow has refused to
   * take a client's word for money since the first line of it.
   *
   * 🔴 A CANCEL IS NOT A CONCLUSION EITHER. The attempt stays open on the
   * server until the server closes it, so a barber who backs out mid-tap still
   * cannot immediately take cash. That is the intended behaviour: the card may
   * have been read a moment before they gave up.
   */
  const runTapToPay = useCallback(
    async (rid: string): Promise<ChargeCardResult> => {
      const opened = await startTapToPayAction(appointmentId, {
        amountCents: chargeCents,
        requestId: rid,
      });
      if (!opened.ok || !opened.attemptId) {
        return { ok: false, error: opened.error ?? "tap_to_pay_unavailable", dueCents: opened.dueCents };
      }
      // A replay of a press that already finished. Do not put a phone back in
      // front of the customer for money that has been taken.
      if (opened.attempt && opened.attempt.state === "succeeded") {
        return { ok: true, result: "paid", amountCents: chargeCents, attempt: opened.attempt };
      }
      if (!opened.clientSecret) {
        // Open, but with no intent to collect against - the mint failed, or is
        // mid-flight. The server owns it from here.
        await load();
        return { ok: false, error: "tap_to_pay_failed" };
      }

      // The Location AND the destination account both come from the route that
      // mints connection tokens - a reader cannot connect without either, and
      // this way a resumed press does not need them echoed back to it.
      const conn = await terminalConnectionTokenAction();
      if (!conn.ok || !conn.locationId || !conn.connectAccountId) {
        // The attempt is open and no card was ever presented. Ask the server to
        // read the untouched intent and close it, or every other method stays
        // blocked behind an attempt nothing will ever finish.
        await settleTapToPayAction(appointmentId, { attemptId: opened.attemptId });
        await load();
        return { ok: false, error: "tap_to_pay_unavailable" };
      }

      const reported = await collectWithPhone(
        {
          requestId: rid,
          clientSecret: opened.clientSecret,
          connectAccountId: conn.connectAccountId,
          locationId: conn.locationId,
          amountCents: chargeCents,
        },
        async () => (await terminalConnectionTokenAction()).secret ?? null,
      );

      // The device could not even try. Nothing was presented, so there is
      // nothing for the server to find - but it is still the server that says
      // so, by reading the untouched intent.
      const settled = await settleTapToPayAction(appointmentId, { attemptId: opened.attemptId });
      if (settled.attempt?.state === "succeeded") {
        return { ...settled, ok: true, result: "paid", amountCents: chargeCents };
      }
      await load();
      return {
        ok: false,
        error:
          reported.outcome === "unavailable"
            ? "tap_to_pay_unavailable"
            : reported.outcome === "canceled"
              ? "tap_to_pay_canceled"
              : "tap_to_pay_failed",
      };
    },
    // `load` is defined below and stable; chargeCents changes with the balance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appointmentId, chargeCents],
  );


  if (stale && !state) {
    return <LoadFailed what="this checkout" failure="stale" onRetry={loadOrSayWhy} />;
  }
  if (loadError) {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-sm text-danger-soft">
          {loadError}
        </p>
        <button type="button" onClick={loadOrSayWhy} className="text-sm text-gold underline">
          Try again
        </button>
      </div>
    );
  }
  if (!state) {
    return <p className="py-8 text-center text-sm text-muted">Loading…</p>;
  }

  const live = state.liveAttempt;
  const savedCard = state.methods.savedCard;

  //  ── a collection is already open ────────────────────────────────────────
  // 🔴 Shown INSTEAD of the methods, never beside them. While an attempt is
  // unresolved, offering any way to collect is offering a second charge.
  if (live && step !== "result") {
    const ambiguous = live.state === "ambiguous";
    const needsAuth = live.state === "requires_action";
    // pending / processing: started, not finished. A tap is checked by reading
    // Stripe (settle); a saved card resolves itself, so this re-reads.
    const tapOpen = !ambiguous && !needsAuth && live.method === "tap_to_pay";
    const stillConfirming = !ambiguous && !needsAuth && !tapOpen;
    return (
      <div className="flex flex-col gap-4">
        <div
          className={cn(
            "rounded-xl border px-4 py-3 text-sm",
            ambiguous
              ? "border-danger-soft/40 bg-danger-soft/5 text-danger-soft"
              : "border-gold/40 bg-gold/5 text-gold",
          )}
          role="alert"
        >
          <p className="font-medium">
            {ambiguous
              ? "We could not confirm that charge"
              : needsAuth
                ? "This card needs the customer to authenticate"
                : tapOpen
                  ? "A Tap to Pay charge is still open"
                  : "Still confirming this charge"}
          </p>
          <p className="mt-1 text-xs leading-relaxed">
            {ambiguous
              ? `${money(live.amountCents)} may or may not have been taken. Do not collect again — this resolves itself shortly, and collecting now is how someone gets charged twice.`
              : needsAuth
                ? `${money(live.amountCents)} has NOT been charged. Cancel this attempt to take payment another way.`
                : tapOpen
                  ? `Check it before taking ${money(live.amountCents)} another way. The card may have been read.`
                  : `${money(live.amountCents)} is still being confirmed. Do not collect again. Check again in a moment.`}
          </p>
        </div>
        {(tapOpen || stillConfirming) && (
          <button
            type="button"
            disabled={busy}
            data-qa="check-attempt"
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                if (tapOpen) {
                  const r = await settleTapToPayAction(appointmentId, { attemptId: live.id });
                  if (!r.ok) setError("Couldn't check that tap. Try again in a moment.");
                }
                await load();
              } catch {
                setError("Couldn't check. Check your connection and try again.");
              } finally {
                setBusy(false);
              }
            }}
            className="min-h-[2.75rem] rounded-lg border border-subtle px-4 text-sm text-offwhite disabled:opacity-50"
          >
            {busy ? "Checking…" : tapOpen ? "Check the tap" : "Check again"}
          </button>
        )}
        {needsAuth && (
          <button
            type="button"
            disabled={busy}
            data-qa="cancel-attempt"
            onClick={async () => {
              setBusy(true);
              let res: { ok: boolean };
              try {
                res = await cancelCheckoutAttemptAction(appointmentId, live.id);
              } catch {
                res = { ok: false };
              } finally {
                setBusy(false);
              }
              if (!res.ok) {
                setError("Couldn't cancel that attempt. Try again in a moment.");
                return;
              }
              await load();
            }}
            className="min-h-[2.75rem] rounded-lg border border-subtle px-4 text-sm text-offwhite disabled:opacity-50"
          >
            {busy ? "Cancelling…" : "Cancel and choose another method"}
          </button>
        )}
        <button
          type="button"
          onClick={onBackToAppointment}
          className="text-sm text-muted underline"
        >
          Back to the appointment
        </button>
        {error && (
          <p role="alert" className="text-xs text-danger-soft">
            {error}
          </p>
        )}
      </div>
    );
  }

  //  ── result ──────────────────────────────────────────────────────────────
  if (step === "result" && outcome) {
    const paid = outcome.result === "paid";
    // A card was charged from file, as opposed to tapped or recorded by hand.
    const fromFile = outcome.attempt?.method === "saved_card" || choice?.kind === "saved_card";
    const firstName = firstNameOf(state.appointment.clientName);
    return (
      <div className="flex flex-col gap-4" data-qa="checkout-result">
        <div
          className={cn(
            "rounded-2xl border px-4 py-6 text-center",
            paid
              ? "border-emerald-soft/40 bg-emerald-soft/5"
              : "border-danger-soft/40 bg-danger-soft/5",
          )}
        >
          {paid && (
            <span
              aria-hidden
              className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-soft/15 text-emerald-soft"
            >
              <CheckIcon className="h-7 w-7" />
            </span>
          )}
          <p
            className={cn(
              "text-xs font-medium uppercase tracking-[0.14em]",
              paid ? "text-emerald-soft" : "text-danger-soft",
            )}
          >
            {paid ? "Paid" : outcome.result === "declined" ? "Declined" : "Not charged"}
          </p>
          <p className="mt-1.5 font-display text-5xl leading-none tabular-nums text-offwhite">
            {money(outcome.amountCents ?? chargeCents)}
          </p>
          <p className="mt-2.5 text-sm text-muted">
            {outcome.card?.last4 ? cardName(outcome.card) : methodLabel(choice, outcome)}
          </p>
          {state.appointment.clientName && (
            <p className="mt-0.5 text-xs text-muted">{state.appointment.clientName}</p>
          )}
          {outcome.paidAt && (
            <p className="mt-2 text-xs text-muted">
              {new Date(outcome.paidAt).toLocaleString(undefined, timeZone ? { timeZone } : undefined)}
            </p>
          )}
          {outcome.receiptReference && (
            <p className="mt-2 break-all text-[11px] text-muted/80">
              Reference {outcome.receiptReference}
            </p>
          )}
          {!paid && outcome.message && (
            <p className="mt-2 text-xs leading-relaxed text-danger-soft">{outcome.message}</p>
          )}
        </div>
        {/* Only for a card charged from file: that is the one method whose
            receipt ChairBack sends (the customer was promised it when they
            agreed). A tap or cash has no such email, so it gets no such line. */}
        {paid && fromFile && (
          <p className="text-center text-xs text-muted" data-qa="receipt-sent">
            A receipt is on its way to the email on their booking.
          </p>
        )}
        {/* Taking the money does not finish the cut - Done still does, and Done
            is where the punch is earned. Saying so here is the difference
            between a barber who knows there is a step left and one who finds
            out at the end of the day. */}
        {paid && state.appointment.status === "BOOKED" && (
          <p className="text-center text-xs text-muted">
            Still on the books — mark it done when you are finished.
          </p>
        )}
        {/* Paid is the best moment to get the next one on the books, so where
            the calendar can answer it, that is the main button. Never offered
            after a refusal: the money comes first. */}
        {paid && onBookNext && (
          <button
            type="button"
            data-qa="book-next"
            onClick={() => {
              onDone();
              onBookNext();
            }}
            className="min-h-[3.5rem] rounded-full bg-gold px-4 font-display text-lg text-charcoal-900 transition-colors duration-150 ease-out hover:bg-gold-muted"
          >
            {firstName ? `Book ${firstName}’s next visit` : "Book their next visit"}
          </button>
        )}
        <button
          type="button"
          data-qa="back-to-appointment"
          onClick={() => {
            onDone();
            onBackToAppointment();
          }}
          className={cn(
            "min-h-[3rem] rounded-full px-4 font-medium transition-colors duration-150 ease-out",
            paid && onBookNext
              ? "border border-subtle-strong text-offwhite hover:bg-charcoal-700"
              : "bg-gold text-charcoal-900 hover:bg-gold-muted",
          )}
        >
          Back to the appointment
        </button>
        {!paid && (
          <button
            type="button"
            onClick={async () => {
              // A refusal is retryable: a NEW press, so a new request id.
              requestId.current = null;
              setOutcome(null);
              setChoice(null);
              setStep("review");
              await load();
            }}
            className="text-sm text-gold underline"
          >
            Try another method
          </button>
        )}
      </div>
    );
  }

  //  ── confirm ─────────────────────────────────────────────────────────────
  if (step === "confirm" && choice) {
    // 🔴 "CHARGE" ONLY WHERE CHAIRBACK TAKES THE MONEY. Cash, a transfer, a
    // card on the barber's own reader and "Other" are RECORDED: this screen
    // moves nothing. A button reading "Charge $50.00" under "Card on your own
    // reader" is how a barber believes the card was run when it was not.
    const records = choice.kind === "cash_other";
    // A card saved for no-show fees only. The customer never agreed to pay for
    // the service with it, so the barber asks and says they did.
    const askFirst = choice.kind === "saved_card" && savedCard.needsBarberOk === true;
    const customer = firstNameOf(state.appointment.clientName);
    return (
      <div className="flex flex-col gap-5" data-qa="checkout-confirm">
        <div className="text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            {records ? "Confirm this payment" : "Confirm this charge"}
          </p>
          <p className="mt-2 font-display text-5xl leading-none tabular-nums text-offwhite">
            {money(chargeCents)}
          </p>
          {state.appointment.clientName && (
            <p className="mt-2.5 text-sm text-muted [overflow-wrap:anywhere]">
              {state.appointment.clientName}
              {state.appointment.serviceName ? ` · ${state.appointment.serviceName}` : ""}
            </p>
          )}
        </div>

        {choice.kind === "saved_card" ? (
          <>
            {/* THE card, named, alone on the screen: what is about to be
                charged is never a guess. */}
            <div
              className="flex items-center gap-3.5 rounded-2xl border border-gold bg-charcoal-800 px-3.5 py-3"
              data-qa="confirm-card"
            >
              <span aria-hidden className="shrink-0 text-gold">
                <CardIcon />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-semibold text-offwhite">{cardName(savedCard.card)}</span>
                <span className="text-xs text-muted">Card on file</span>
              </span>
            </div>
            {/* 🔴 ONLY WHAT IS TRUE OF EVERY CHARGE THIS BUTTON CAN MAKE. The
                server offers this method only with the customer's own tick for
                this appointment, sends a receipt for every saved-card charge
                (services/serviceChargeReceipt.ts), and pays the shop's
                connected account. A line that needs "usually" does not belong
                here: the barber reads these aloud. */}
            {askFirst ? (
              // 🔴 THE ONE THING THIS CARD WAS NOT SAVED FOR. Said before the
              // tick, so the barber knows what they are vouching for, and the
              // tick is the barber's own word - never pre-ticked, never kept
              // from a previous visit to this step.
              <div
                className="flex flex-col gap-3 rounded-2xl bg-charcoal-700 px-4 py-3.5 text-xs leading-relaxed text-offwhite"
                data-qa="saved-card-ask-first"
              >
                <p>
                  {customer ?? "The customer"} saved this card for no-show fees only. Ask them before you
                  charge it for the {vocab.serviceNoun}.
                </p>
                <label className="flex min-h-[2.75rem] cursor-pointer items-start gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    data-qa="client-said-yes"
                    checked={clientOk}
                    disabled={busy}
                    onChange={(e) => setClientOk(e.target.checked)}
                    className="mt-0.5 h-5 w-5 shrink-0 accent-gold"
                  />
                  <span className="min-w-0">
                    {customer ?? "They"} said yes to paying {money(chargeCents)} with this card
                  </span>
                </label>
                <ul className="flex flex-col gap-2">
                  <Assurance>A receipt goes to the email on their booking.</Assurance>
                  <Assurance>The money goes to your Stripe account.</Assurance>
                </ul>
              </div>
            ) : (
              <ul
                className="flex flex-col gap-2 rounded-2xl bg-charcoal-700 px-4 py-3.5 text-xs leading-relaxed text-offwhite"
                data-qa="saved-card-promises"
              >
                <Assurance>
                  {customer ?? "The customer"} agreed when booking to pay for this appointment with this
                  card.
                </Assurance>
                <Assurance>A receipt goes to the email on their booking.</Assurance>
                <Assurance>The money goes to your Stripe account.</Assurance>
              </ul>
            )}
          </>
        ) : (
          <p className="text-center text-sm text-offwhite">{confirmMethodLine(choice, savedCard)}</p>
        )}

        {error && (
          <p role="alert" className="text-center text-sm text-danger-soft">
            {error}
          </p>
        )}

        <button
          type="button"
          data-qa="confirm-charge"
          // 🔴 The double-tap guard the customer can see. The requestId makes a
          // second press harmless server-side; this makes it impossible.
          disabled={busy || (askFirst && !clientOk)}
          aria-describedby={askFirst && !clientOk ? "ask-first-hint" : undefined}
          onClick={async () => {
            if (busy || (askFirst && !clientOk)) return;
            setBusy(true);
            setError(null);
            if (!requestId.current) requestId.current = newRequestId();
            let res: ChargeCardResult;
            try {
              res =
                choice.kind === "saved_card"
                  ? await chargeSavedCardAction(appointmentId, {
                      amountCents: chargeCents,
                      requestId: requestId.current,
                      ...(askFirst ? { barberConfirmedClientOk: true as const } : {}),
                    })
                  : choice.kind === "tap_to_pay"
                    ? await runTapToPay(requestId.current)
                    : await recordCashCheckoutAction(appointmentId, {
                        amountCents: chargeCents,
                        method: choice.method,
                        requestId: requestId.current,
                        confirmed: true,
                      });
            } catch {
              // 🔴 NO ANSWER REACHED THIS PHONE (signal lost, app backgrounded).
              // It may have gone through. requestId is kept, so pressing again
              // is a replay, never a second charge.
              setError(UNCONFIRMED_COPY);
              setBusy(false);
              await load().catch(() => {});
              return;
            }
            setBusy(false);

            // 🔴 A REPLAY REPORTS WHERE THE FIRST PRESS GOT TO, and has no
            // `result` of its own. Read without this, a card that WAS charged
            // came back as "Not charged" - and a barber collects again.
            if (res.replay && res.attempt) {
              const a = res.attempt;
              if (a.state === "succeeded") {
                setOutcome({
                  ...res,
                  ok: true,
                  result: "paid",
                  amountCents: a.amountCents,
                  card: a.card ?? null,
                  paidAt: a.settledAt,
                });
                setStep("result");
                onDone();
                return;
              }
              if (a.state === "failed") {
                setOutcome({ ...res, ok: false, result: "declined", amountCents: a.amountCents });
                setStep("result");
                return;
              }
              // Still open (pending, processing, requires_action, ambiguous) or
              // cancelled: the re-read balance and live attempt tell the truth.
              await load();
              return;
            }

            if (
              res.result === "requires_action" ||
              res.result === "ambiguous" ||
              res.result === "processing"
            ) {
              // Not paid, and not retryable from here: re-read so the live
              // attempt banner takes over the screen.
              await load();
              return;
            }
            if (!res.ok && !res.result) {
              setError(errorCopy(res.error, res.dueCents, vocab.serviceNoun));
              // An unknown failure may still have landed: re-read, so a charge
              // that went through shows as a zero balance or an open attempt.
              if (!DEFINITE_REFUSALS.has(res.error ?? "")) await load().catch(() => {});
              return;
            }
            setOutcome(res);
            setStep("result");
            onDone();
          }}
          className="min-h-[3.5rem] rounded-full bg-gold px-4 font-display text-xl text-charcoal-900 transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-60"
        >
          {records
            ? busy
              ? "Recording…"
              : `Record ${money(chargeCents)}`
            : busy
              ? "Charging…"
              : `Charge ${money(chargeCents)}`}
        </button>
        {askFirst && !clientOk && (
          <p id="ask-first-hint" className="-mt-2 text-center text-xs text-muted">
            Tick that {customer ?? "they"} said yes to charge this card.
          </p>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setStep("review");
            setChoice(null);
            setError(null);
            // Abandoning the confirm step abandons that press.
            requestId.current = null;
          }}
          className="min-h-[2.75rem] text-sm text-muted underline disabled:opacity-50"
        >
          Pick another way to pay
        </button>
      </div>
    );
  }

  //  ── review ──────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4" data-qa="checkout-review">
      <div className="min-w-0">
        <p className="[overflow-wrap:anywhere] text-base font-semibold text-offwhite">
          {state.appointment.clientName ?? "Walk-in"}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {new Date(state.appointment.startsAt).toLocaleString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            ...(timeZone ? { timeZone } : {}),
          })}
        </p>
      </div>

      {/* A refusal that happens on THIS step - so far, only Apple's required
          Tap to Pay walkthrough failing to appear. Without this the barber
          taps the method, nothing visibly happens, and they tap it again. */}
      {error && (
        <p role="alert" className="text-center text-sm text-danger-soft">
          {error}
        </p>
      )}

      {/* The ticket: what is being paid for, what is already in, and the one
          figure every method on this screen will take. */}
      <div className="rounded-2xl border border-subtle bg-charcoal-800 px-4 py-4" data-qa="ticket">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">On the ticket</p>
        <div className="mt-2.5 flex flex-col gap-1.5">
          <Row
            label={state.appointment.serviceName ?? "Appointment"}
            value={state.totalCents === null ? "—" : money(state.totalCents)}
            strong
          />
          {state.collectedCents > 0 && (
            <Row label="Already paid" value={`−${money(state.collectedCents)}`} tone="emerald" />
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2 border-t border-subtle pt-3">
          <span className="text-sm text-muted">Amount due</span>
          <span className="font-display text-4xl leading-none tabular-nums text-offwhite" data-qa="amount-due">
            {dueCents === null ? "—" : money(chargeCents)}
          </span>
        </div>
        {/* Said plainly, so a barber looking for the edit box knows where the
            number comes from instead of hunting for one that is not there. */}
        <p className="mt-2 text-xs text-muted">
          The full balance. To change it, edit the {"price"} on the appointment.
        </p>
      </div>

      {/* 🔴 NOTHING TO COLLECT, NO METHODS. The server takes exactly the
          balance and refuses 0, so "Charge $0.00" on a paid-in-full or
          unpriced booking failed on every method, every time. */}
      {dueCents === null || dueCents === 0 ? (
        <p
          className="rounded-lg border border-subtle/60 px-3.5 py-3 text-center text-sm text-muted"
          data-qa="nothing-due"
        >
          {dueCents === 0
            ? "Nothing left to collect. This was paid in full."
            : "This appointment has no price yet. Set the price on the appointment before checking out."}
        </p>
      ) : (
      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">How are they paying?</p>
        <div className="mt-2 flex flex-col gap-2">
          {savedCard.available && savedCard.card?.last4 ? (
            // First, because it is the one the customer already set up. Not
            // preselected: it opens the confirm step like every other method.
            <MethodButton
              qa="method-saved-card"
              label="Card on file"
              hint={
                savedCard.needsBarberOk
                  ? `${cardName(savedCard.card)} · saved for no-show fees, ask first`
                  : cardName(savedCard.card)
              }
              icon={<CardIcon />}
              lead
              onClick={() => {
                setClientOk(false);
                setChoice({ kind: "saved_card" });
                setStep("confirm");
              }}
            />
          ) : (
            // 🔴 Never rendered as a usable button. A card that cannot be
            // charged is shown as the reason it cannot, or not at all.
            savedCard.blocker &&
            savedCard.blocker !== "no_card" && (
              <MethodUnavailable>
                {savedCardBlockerCopy(savedCard.blocker, savedCard.approvedUpToCents)}
              </MethodUnavailable>
            )
          )}

          {/* 🔴 TWO HALVES, AND BOTH MUST BE TRUE. The server knows the flag,
              Connect and where the money goes; only the device knows whether it
              has the reader, the entitlement and a supported iPhone. Offering
              this on the strength of either half alone is how a barber presses
              a button that cannot work, in front of a customer. */}
          {state.methods.tapToPay.available && nativeReady ? (
            <MethodButton
              qa="method-tap-to-pay"
              label="Tap to Pay"
              hint="Hold their card or phone to this iPhone"
              icon={<TapIcon />}
              onClick={async () => {
                // 🔴 APPLE'S REQUIRED EDUCATION, AT THE ENABLING POINT. Stripe's
                // docs: Apple requires a "How to Tap" overlay when enabling Tap
                // to Pay, integrated before the app is submitted for review. It
                // runs HERE rather than at confirm, because the native overlay
                // has no dismissal callback and must not land on top of a live
                // collection. After the first time it returns `already` and
                // this is a no-op.
                if (busy) return;
                setBusy(true);
                setError(null);
                const taught = await requestTapToPayEducation(newRequestId());
                setBusy(false);
                if (taught.outcome === "failed") {
                  // Not educated, so not offered. Proceeding would ship around
                  // the requirement and hand a barber a reader they were never
                  // shown how to use.
                  setError(errorCopy("tap_to_pay_education_failed", undefined, vocab.serviceNoun));
                  return;
                }
                setChoice({ kind: "tap_to_pay" });
                setStep("confirm");
              }}
            />
          ) : (
            <MethodUnavailable>
              Tap to Pay —{" "}
              {state.methods.tapToPay.available
                ? BLOCKER_COPY.native_not_ready
                : (BLOCKER_COPY[state.methods.tapToPay.blocker ?? ""] ?? "not available")}
            </MethodUnavailable>
          )}

          {CASH_METHODS.map((m) => (
            <MethodButton
              key={m.key}
              qa={`method-${m.key}`}
              label={m.label}
              hint={m.hint}
              icon={CASH_ICONS[m.key]}
              onClick={() => {
                setChoice({ kind: "cash_other", method: m.key });
                setStep("confirm");
              }}
            />
          ))}
        </div>
      </div>
      )}
      {reviewExtra}
    </div>
  );
}

function Row({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: string;
  tone?: "emerald";
  /** The thing being paid for, rather than an adjustment to it. */
  strong?: boolean;
}) {
  return (
    // No wrap: a long service name breaks inside its own column, and the
    // figure stays on the right where every other figure is.
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span
        className={cn(
          "min-w-0 flex-1 [overflow-wrap:anywhere]",
          tone === "emerald" ? "text-emerald-soft" : strong ? "font-medium text-offwhite" : "text-muted",
        )}
      >
        {label}
      </span>
      <span
        className={cn("shrink-0 tabular-nums", tone === "emerald" ? "text-emerald-soft" : "text-offwhite")}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * One way to pay: what it is, one line about it, and a chevron, because
 * choosing a method only ever moves to the confirm step.
 *
 * `lead` marks the card on file, the one method the customer already set up.
 * It is drawn first and outlined in gold; nothing is preselected by it.
 */
function MethodButton({
  label,
  hint,
  icon,
  lead,
  onClick,
  qa,
}: {
  label: string;
  hint: string;
  icon: React.ReactNode;
  lead?: boolean;
  onClick: () => void;
  qa: string;
}) {
  return (
    <button
      type="button"
      data-qa={qa}
      onClick={onClick}
      className={cn(
        "flex min-h-[3.75rem] w-full items-center gap-3.5 rounded-2xl border bg-charcoal-800 px-3.5 py-2.5 text-left transition-colors duration-150 ease-out",
        lead ? "border-gold hover:border-gold-muted" : "border-subtle hover:border-subtle-strong",
      )}
    >
      <span aria-hidden className={cn("shrink-0", lead ? "text-gold" : "text-offwhite")}>
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-semibold text-offwhite">{label}</span>
        <span className="text-xs text-muted [overflow-wrap:anywhere]">{hint}</span>
      </span>
      <ChevronIcon />
    </button>
  );
}

/** One line the barber can say to the customer before charging their card. */
function Assurance({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <CheckIcon className="mt-px shrink-0 text-emerald-soft" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/** A method that cannot be used here, as the reason it cannot. Never a button. */
function MethodUnavailable({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-2xl border border-dashed border-subtle px-3.5 py-3 text-xs leading-relaxed text-muted">
      {children}
    </p>
  );
}

/** Stripe's brand keys, as a person would say them. Unknown brands stay honest. */
const BRAND_NAMES: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "Amex",
  american_express: "Amex",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
};

/** "Visa ending 4242", or "Card ending 4242" when the brand is not known. */
export function cardName(card: { brand: string | null; last4: string | null } | null | undefined): string {
  if (!card?.last4) return "Card on file";
  const key = (card.brand ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  return `${BRAND_NAMES[key] ?? "Card"} ending ${card.last4}`;
}

/** The first name alone, for a sentence about the customer. */
function firstNameOf(name: string | null): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

const ICON = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function CardIcon() {
  return (
    <svg {...ICON} aria-hidden>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M2.5 10h19" />
    </svg>
  );
}

function TapIcon() {
  return (
    <svg {...ICON} aria-hidden>
      <path d="M8.5 15.5a5 5 0 0 1 0-7" />
      <path d="M12 18a8.5 8.5 0 0 1 0-12" />
      <path d="M15.5 20.5a12 12 0 0 1 0-17" />
    </svg>
  );
}

function CashIcon() {
  return (
    <svg {...ICON} aria-hidden>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

function TransferIcon() {
  return (
    <svg {...ICON} aria-hidden>
      <path d="M4 8h13" />
      <path d="M14 4l4 4-4 4" />
      <path d="M20 16H7" />
      <path d="M10 12l-4 4 4 4" />
    </svg>
  );
}

function OtherIcon() {
  return (
    <svg {...ICON} fill="currentColor" stroke="none" aria-hidden>
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg {...ICON} width={18} height={18} strokeWidth={2} aria-hidden className="shrink-0 text-muted">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg {...ICON} width={18} height={18} strokeWidth={2.2} aria-hidden className={className}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function ReaderIcon() {
  return (
    <svg {...ICON} aria-hidden>
      <rect x="6" y="3" width="12" height="18" rx="2.5" />
      <path d="M9 7.5h6" />
      <path d="M9.5 16.5h5" />
    </svg>
  );
}

const CASH_ICONS = {
  cash: <CashIcon />,
  direct: <TransferIcon />,
  card: <ReaderIcon />,
  other: <OtherIcon />,
} as const;

function confirmMethodLine(
  choice: Choice,
  savedCard: { card?: { brand: string | null; last4: string | null } | null },
): string {
  if (choice.kind === "saved_card") {
    const last4 = savedCard.card?.last4;
    return last4 ? `Saved card ending •••• ${last4}` : "Saved card";
  }
  if (choice.kind === "tap_to_pay") return "Tap to Pay";
  // "No card charged" would read wrongly beside a card: one IS being charged,
  // on their reader. What matters is that this screen does not do it.
  if (choice.method === "card") return "Card on your own reader — recorded only. Run it on your reader.";
  const label = CASH_METHODS.find((m) => m.key === choice.method)?.label ?? "Other";
  return `${label} — recorded, no card charged`;
}

function methodLabel(choice: Choice | null, outcome: ChargeCardResult): string {
  if (outcome.attempt?.method === "saved_card" || choice?.kind === "saved_card") return "Saved card";
  if (outcome.attempt?.method === "tap_to_pay" || choice?.kind === "tap_to_pay") return "Tap to Pay";
  if (choice?.kind === "cash_other") {
    return CASH_METHODS.find((m) => m.key === choice.method)?.label ?? "Other";
  }
  return "Recorded in person";
}

function errorCopy(
  error: string | undefined,
  dueCents: number | undefined,
  // The shop's own word for the thing being paid for; a barbershop reads "cut"
  // and a clinic reads "appointment". Passed in because this is a plain
  // function - the hook that resolves it belongs to the component.
  serviceNoun: string,
): string {
  switch (error) {
    case "amount_not_authorized":
      // The screen and the server are looking at different money - almost
      // always a price edited in another tab. Re-reading fixes it.
      return `The balance is ${money(dueCents ?? 0)}, not what this screen showed. Close and reopen checkout.`;
    case "collection_in_progress":
      return "Another collection is still open on this appointment.";
    case "paid_already":
      return `This ${serviceNoun} has already been checked out.`;
    case "no_service_consent":
      return "This card was only approved for no-show fees.";
    case "barber_ok_required":
      // The server is newer than this screen and asks for the barber's word.
      return "This card was saved for no-show fees. Close and reopen checkout to charge it.";
    case "not_finished":
      return "The saved card can be charged once the appointment is done.";
    case "over_agreed_price":
      return "The balance is more than the customer approved this card for. Take it another way.";
    case "tap_to_pay_unavailable":
      return "This phone can't take contactless payments. Try another way.";
    case "tap_to_pay_education_failed":
      // Apple requires the How to Tap walkthrough before the first payment. If
      // it could not be shown, Tap to Pay is not offered - so this says what to
      // do rather than what failed.
      return "Couldn't show the Tap to Pay walkthrough. Take payment another way for now.";
    // Shop-level, not device-level, and worth telling apart: one is fixed by
    // using a different phone, the other by an owner changing a setting.
    case "tap_to_pay_disabled":
      return "Tap to Pay isn't turned on for this shop.";
    case "connect_required":
      return "Connect a payout account before taking card payments.";
    case "consent_withdrawn":
      return "The customer stopped charges to this card. Take payment another way.";
    case "tap_to_pay_canceled":
      // Deliberately not "nothing was charged": the card may have been read a
      // moment before the barber backed out, and only the server knows.
      return "Tap to Pay was stopped. Check the balance before collecting again.";
    case "tap_to_pay_failed":
      return "That tap didn't go through. Check the balance before trying again.";
    // Refused before any money was asked for.
    case "invalid_input":
    case "not_found":
    case "card_unavailable":
    case "no_card":
      return "That didn't go through. Nothing was charged.";
    // 🔴 Anything else - a timeout, a 5xx, an answer we don't recognise - is
    // UNKNOWN. "Nothing was charged" there is how a customer pays twice.
    default:
      return UNCONFIRMED_COPY;
  }
}

const UNCONFIRMED_COPY =
  "We couldn't confirm what happened. Check the balance before collecting again. Pressing Charge again won't charge twice.";

/** Refusals the server makes before any money is asked for: nothing to re-read. */
const DEFINITE_REFUSALS = new Set([
  "amount_not_authorized",
  "paid_already",
  "no_service_consent",
  "barber_ok_required",
  "not_finished",
  "over_agreed_price",
  "consent_withdrawn",
  "tap_to_pay_disabled",
  "connect_required",
  "tap_to_pay_education_failed",
  "invalid_input",
  "not_found",
  "card_unavailable",
  "no_card",
]);
