"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
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
import { collectWithPhone, nativeTapToPayAvailable } from "./tapToPayBridge";

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
  | { kind: "cash_other"; method: "cash" | "direct" | "other" };

/** Why a saved card is unavailable, in words a barber can act on. */
const BLOCKER_COPY: Record<string, string> = {
  no_card: "No card saved for this booking",
  card_not_saved: "The saved card is not usable right now",
  // The distinction the whole consent split exists for.
  no_service_consent: "This card was only approved for no-show fees",
  consent_not_for_this_appointment: "This card was approved for a different appointment",
  // The 72-hour post-service window has closed.
  retention_expired: "Too long since this appointment to charge the saved card",
  native_not_ready: "Not set up on this device yet",
  disabled: "Not enabled for this shop",
};

const CASH_METHODS = [
  { key: "cash" as const, label: "Cash", hint: "You keep 100%" },
  { key: "direct" as const, label: "Zelle · Venmo · Cash App", hint: "Sent to your handle" },
  { key: "other" as const, label: "Other", hint: "Comp, trade, split" },
];

export function CheckoutFlow({
  appointmentId,
  onDone,
  onBackToAppointment,
}: {
  appointmentId: string;
  /** A collection landed: the agenda and the sheet need re-reading. */
  onDone: () => void;
  /** The clear way back to the same appointment. */
  onBackToAppointment: () => void;
}) {
  const [state, setState] = useState<CheckoutState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("review");
  const [choice, setChoice] = useState<Choice | null>(null);
  const [outcome, setOutcome] = useState<ChargeCardResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    const res = await getCheckoutAction(appointmentId);
    if (!res.ok || !res.data) {
      setLoadError(res.error ?? "Couldn't load this checkout");
      return;
    }
    setState(res.data);
    setLoadError(null);
  }, [appointmentId]);

  useEffect(() => {
    void load();
  }, [load]);

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
        // The attempt is open and stays open: the server must conclude it.
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


  if (loadError) {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-sm text-danger-soft">
          {loadError}
        </p>
        <button type="button" onClick={() => void load()} className="text-sm text-gold underline">
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
              : "This card needs the customer to authenticate"}
          </p>
          <p className="mt-1 text-xs leading-relaxed">
            {ambiguous
              ? `${money(live.amountCents)} may or may not have been taken. Do not collect again — this resolves itself shortly, and collecting now is how someone gets charged twice.`
              : `${money(live.amountCents)} has NOT been charged. Cancel this attempt to take payment another way.`}
          </p>
        </div>
        {!ambiguous && (
          <button
            type="button"
            disabled={busy}
            data-qa="cancel-attempt"
            onClick={async () => {
              setBusy(true);
              const res = await cancelCheckoutAttemptAction(appointmentId, live.id);
              setBusy(false);
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
    return (
      <div className="flex flex-col gap-4" data-qa="checkout-result">
        <div
          className={cn(
            "rounded-xl border px-4 py-5 text-center",
            paid
              ? "border-emerald-soft/40 bg-emerald-soft/5"
              : "border-danger-soft/40 bg-danger-soft/5",
          )}
        >
          <p
            className={cn(
              "text-xs font-medium uppercase tracking-wide",
              paid ? "text-emerald-soft" : "text-danger-soft",
            )}
          >
            {paid ? "Paid" : outcome.result === "declined" ? "Declined" : "Not charged"}
          </p>
          <p className="mt-1 font-display text-4xl tabular-nums text-offwhite">
            {money(outcome.amountCents ?? chargeCents)}
          </p>
          <p className="mt-2 text-sm text-muted">
            {methodLabel(choice, outcome)}
            {outcome.card?.last4 ? ` ending ${outcome.card.last4}` : ""}
          </p>
          {state.appointment.clientName && (
            <p className="mt-0.5 text-xs text-muted">{state.appointment.clientName}</p>
          )}
          {outcome.paidAt && (
            <p className="mt-2 text-xs text-muted">{new Date(outcome.paidAt).toLocaleString()}</p>
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
        {/* Taking the money does not finish the cut - Done still does, and Done
            is where the punch is earned. Saying so here is the difference
            between a barber who knows there is a step left and one who finds
            out at the end of the day. */}
        {paid && state.appointment.status === "BOOKED" && (
          <p className="text-center text-xs text-muted">
            Still on the books — mark it done when you are finished.
          </p>
        )}
        <button
          type="button"
          data-qa="back-to-appointment"
          onClick={() => {
            onDone();
            onBackToAppointment();
          }}
          className="min-h-[2.75rem] rounded-lg bg-gold px-4 font-medium text-charcoal-900"
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
    return (
      <div className="flex flex-col gap-5" data-qa="checkout-confirm">
        <div className="text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            Confirm this charge
          </p>
          <p className="mt-2 font-display text-5xl tabular-nums text-offwhite">
            {money(chargeCents)}
          </p>
          <p className="mt-2 text-sm text-offwhite">{confirmMethodLine(choice, savedCard)}</p>
          {state.appointment.clientName && (
            <p className="mt-1 text-xs text-muted">
              {state.appointment.clientName}
              {state.appointment.serviceName ? ` · ${state.appointment.serviceName}` : ""}
            </p>
          )}
        </div>

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
          disabled={busy}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            setError(null);
            if (!requestId.current) requestId.current = newRequestId();
            const res =
              choice.kind === "saved_card"
                ? await chargeSavedCardAction(appointmentId, {
                    amountCents: chargeCents,
                    requestId: requestId.current,
                  })
                : choice.kind === "tap_to_pay"
                  ? await runTapToPay(requestId.current)
                  : await recordCashCheckoutAction(appointmentId, {
                      amountCents: chargeCents,
                      method: choice.method,
                      requestId: requestId.current,
                      confirmed: true,
                    });
            setBusy(false);

            if (res.result === "requires_action" || res.result === "ambiguous") {
              // Not paid, and not retryable from here: re-read so the live
              // attempt banner takes over the screen.
              await load();
              return;
            }
            if (!res.ok && !res.result) {
              setError(errorCopy(res.error, res.dueCents, vocab.serviceNoun));
              return;
            }
            setOutcome(res);
            setStep("result");
            onDone();
          }}
          className="min-h-[3.25rem] rounded-xl bg-gold px-4 font-display text-lg text-charcoal-900 disabled:opacity-60"
        >
          {busy ? "Charging…" : `Charge ${money(chargeCents)}`}
        </button>
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
          className="text-sm text-muted underline disabled:opacity-50"
        >
          Back
        </button>
      </div>
    );
  }

  //  ── review ──────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4" data-qa="checkout-review">
      <div className="rounded-xl border border-subtle bg-charcoal-800/40 px-4 py-3 text-center">
        <p className="[overflow-wrap:anywhere] text-sm font-medium text-offwhite">
          {state.appointment.clientName ?? "Walk-in"}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {state.appointment.serviceName ?? "Appointment"}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {new Date(state.appointment.startsAt).toLocaleString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        {state.totalCents !== null && (
          <Row label="Ticket" value={money(state.totalCents)} />
        )}
        {state.collectedCents > 0 && (
          <Row label="Already paid" value={`−${money(state.collectedCents)}`} tone="emerald" />
        )}
      </div>

      <div className="border-t border-subtle pt-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm text-muted">Amount due</span>
          <span className="font-display text-3xl tabular-nums text-offwhite" data-qa="amount-due">
            {dueCents === null ? "—" : money(chargeCents)}
          </span>
        </div>
        {/* Said plainly, so a barber looking for the edit box knows where the
            number comes from instead of hunting for one that is not there. */}
        <p className="mt-1 text-xs text-muted">
          The full balance. To change it, edit the {"price"} on the appointment.
        </p>
      </div>

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">How are they paying?</p>
        <div className="mt-2 flex flex-col gap-1.5">
          {savedCard.available && savedCard.card?.last4 ? (
            <MethodButton
              qa="method-saved-card"
              label={`Charge card ending •••• ${savedCard.card.last4}`}
              hint={savedCard.card.brand ?? "Saved card"}
              onClick={() => {
                setChoice({ kind: "saved_card" });
                setStep("confirm");
              }}
            />
          ) : (
            // 🔴 Never rendered as a usable button. A card that cannot be
            // charged is shown as the reason it cannot, or not at all.
            savedCard.blocker &&
            savedCard.blocker !== "no_card" && (
              <p className="rounded-lg border border-subtle/60 px-3.5 py-2.5 text-xs text-muted">
                {BLOCKER_COPY[savedCard.blocker] ?? "Saved card unavailable"}
              </p>
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
              hint="Hold their card to this phone"
              onClick={() => {
                setChoice({ kind: "tap_to_pay" });
                setStep("confirm");
              }}
            />
          ) : (
            <p className="rounded-lg border border-subtle/60 px-3.5 py-2.5 text-xs text-muted">
              Tap to Pay —{" "}
              {state.methods.tapToPay.available
                ? BLOCKER_COPY.native_not_ready
                : (BLOCKER_COPY[state.methods.tapToPay.blocker ?? ""] ?? "not available")}
            </p>
          )}

          {CASH_METHODS.map((m) => (
            <MethodButton
              key={m.key}
              qa={`method-${m.key}`}
              label={m.label}
              hint={m.hint}
              onClick={() => {
                setChoice({ kind: "cash_other", method: m.key });
                setStep("confirm");
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "emerald";
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
      <span className={tone === "emerald" ? "text-emerald-soft" : "text-muted"}>{label}</span>
      <span
        className={cn("tabular-nums", tone === "emerald" ? "text-emerald-soft" : "text-offwhite")}
      >
        {value}
      </span>
    </div>
  );
}

function MethodButton({
  label,
  hint,
  onClick,
  qa,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  qa: string;
}) {
  return (
    <button
      type="button"
      data-qa={qa}
      onClick={onClick}
      className="flex min-h-[2.75rem] flex-wrap items-center justify-between gap-x-3 gap-y-0.5 rounded-lg border border-subtle px-3.5 py-3 text-left text-sm text-offwhite transition-colors duration-150 ease-out hover:border-subtle-strong"
    >
      <span className="min-w-0 font-medium">{label}</span>
      <span className="shrink-0 text-[11px] text-muted">{hint}</span>
    </button>
  );
}

function confirmMethodLine(
  choice: Choice,
  savedCard: { card?: { brand: string | null; last4: string | null } | null },
): string {
  if (choice.kind === "saved_card") {
    const last4 = savedCard.card?.last4;
    return last4 ? `Saved card ending •••• ${last4}` : "Saved card";
  }
  if (choice.kind === "tap_to_pay") return "Tap to Pay";
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
    case "tap_to_pay_unavailable":
      return "This phone can't take contactless payments. Try another way.";
    // Shop-level, not device-level, and worth telling apart: one is fixed by
    // using a different phone, the other by an owner changing a setting.
    case "tap_to_pay_disabled":
      return "Tap to Pay isn't turned on for this shop.";
    case "connect_required":
      return "Connect a payout account before taking card payments.";
    case "tap_to_pay_canceled":
      // Deliberately not "nothing was charged": the card may have been read a
      // moment before the barber backed out, and only the server knows.
      return "Tap to Pay was stopped. Check the balance before collecting again.";
    case "tap_to_pay_failed":
      return "That tap didn't go through. Check the balance before trying again.";
    default:
      return "That didn't go through. Nothing was charged.";
  }
}
