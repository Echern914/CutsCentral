"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { INPUT } from "./formkit";
import { refundDepositAction } from "./actions";

/**
 * REFUND A KEPT DEPOSIT, FROM CHAIRBACK.
 *
 * A cancelled or no-show booking can keep what was paid at booking: a
 * non-refundable deposit, a late-cancel fee, a no-show. The shop may still want
 * to give it back, and its own Stripe dashboard cannot do that correctly - on a
 * destination charge it shows only a copy, and refunding the copy takes the
 * money back from the shop while the client gets nothing. This button refunds
 * the real charge (the API's billing/depositRefund.ts).
 *
 * Two presses, never one: open, then confirm with the exact figure stated
 * again. The figure sent is the SERVER's, never a typed one.
 *
 * 🔴 THE OUTCOME GOES TO THE SHEET'S FOOTER, NOT A TOAST. A toast draws beneath
 * the dialog, so on a phone it is invisible. And once the money is back the
 * server stops offering it, this panel disappears on the re-read, and a message
 * kept here would vanish with it. "Already refunded" is an outcome too, and
 * goes the same way. Refusals stay here, next to the button.
 */

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** What each refusal means for the person holding the phone. */
export function explainDepositRefund(error: string | undefined, reason: string | undefined): string {
  switch (error) {
    case "amount_changed":
      return "The amount changed since this opened. Check it again before refunding.";
    case "nothing_to_refund":
      return "This has already been refunded. Nothing is left to give back.";
    case "not_refundable":
      return reason === "booking_open"
        ? "Only a cancelled or no-show booking's deposit can be refunded here."
        : "This payment was never collected, so there is nothing to refund.";
    // 🔴 NOT "do it in Stripe". The shop's own Stripe account shows only a copy
    // of this payment, and refunding the copy gives the client nothing.
    case "needs_support":
      return "Stripe's record of this payment doesn't match ChairBack's. Contact ChairBack support to finish this refund - refunding from your own Stripe account won't reach the client.";
    case "refund_refused":
      return "Stripe refused the refund. Nothing was refunded.";
    // The server read Stripe, could not, and asked it for nothing.
    case "stripe_unavailable":
      return "Couldn't reach Stripe. Nothing was refunded - try again.";
    // Refused before anything was asked of Stripe.
    case "invalid_input":
    case "not_found":
    case "forbidden_role":
    case "unauthorized":
    case "subscription_required":
      return "That didn't work. Nothing was refunded.";
    // 🔴 ANYTHING ELSE IS UNKNOWN, NOT "NOTHING HAPPENED": no answer reached
    // this phone (lost signal, a timeout, a 5xx on the way back), and the
    // refund may have been made before it was lost. Pressing again is safe -
    // the same press names the same refund.
    default:
      return "We couldn't confirm the refund yet. Pressing Refund again is safe - it can't refund twice.";
  }
}

export function DepositRefund({
  appointmentId,
  status,
  kept,
  onRefunded,
  onStale,
}: {
  appointmentId: string;
  /** The booking's own status: `canceled` or `no_show`. */
  status: string;
  kept: { amountCents: number; nonRefundable: boolean };
  /** Money went back: say so in the footer, re-read the booking and the agenda. */
  onRefunded: (message: string) => void;
  /** The server's figure moved: re-read the booking so the button shows it. */
  onStale: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  // A plain flag, not useTransition: the refund is one awaited call, and the
  // button must stay disabled for exactly as long as it is in flight.
  const [pending, setPending] = useState(false);
  // Money is back. The panel stops offering it at once, rather than waiting on
  // a re-read that may itself fail and leave a live button under a footer
  // that says it was done.
  const [done, setDone] = useState(false);

  const figure = money(kept.amountCents);

  function finish(message: string) {
    setConfirming(false);
    setNote("");
    setDone(true);
    onRefunded(message);
  }

  async function submit() {
    if (pending) return;
    setMessage(null);
    setPending(true);
    try {
      let res: Awaited<ReturnType<typeof refundDepositAction>>;
      try {
        res = await refundDepositAction(appointmentId, {
          amountCents: kept.amountCents,
          ...(note.trim() ? { note: note.trim() } : {}),
        });
      } catch {
        // No answer reached the phone at all (signal lost, app backgrounded).
        // The refund may have landed; pressing again cannot make a second.
        setMessage(explainDepositRefund("unconfirmed", undefined));
        return;
      }
      if (res.ok) {
        finish(
          res.result === "already_refunded"
            ? "This deposit had already been refunded."
            : res.status === "pending"
              ? `Refund of ${money(res.amountCents ?? kept.amountCents)} sent. Stripe is still processing it.`
              : `Refunded ${money(res.amountCents ?? kept.amountCents)} to the client.`,
        );
        return;
      }
      // Nothing left on the booking: that is an outcome, not a refusal, and it
      // goes where the success would have - the footer outlives this panel.
      if (res.error === "nothing_to_refund") {
        finish("This deposit had already been refunded.");
        return;
      }
      setMessage(explainDepositRefund(res.error, res.reason));
      // A figure that moved is re-read so the button shows the true one.
      if (res.error === "amount_changed") onStale();
    } finally {
      setPending(false);
    }
  }

  if (done) return null;

  return (
    <section
      data-qa="deposit-refund"
      className="min-w-0 rounded-2xl border border-subtle bg-charcoal-800/40 p-3.5 sm:p-4"
    >
      <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-gold/80">
        Paid at booking
      </h3>
      <p className="text-xs leading-relaxed text-muted">
        {status === "no_show"
          ? `${figure} paid at booking was kept for the no-show.`
          : `${figure} paid at booking wasn't refunded when this was cancelled.`}
        {kept.nonRefundable && " It was booked as non-refundable."}
      </p>

      {!confirming && (
        <button
          type="button"
          data-qa="deposit-refund-open"
          onClick={() => {
            setMessage(null);
            setConfirming(true);
          }}
          className="mt-2.5 flex h-10 w-full items-center justify-center rounded-xl border border-danger-soft/40 px-4 text-xs font-medium text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/10"
        >
          Refund {figure}
        </button>
      )}

      {confirming && (
        <div className="mt-2.5 flex flex-col gap-2 rounded-xl border border-danger-soft/30 bg-danger-soft/5 p-3 text-xs">
          <p className="text-sm text-offwhite">Refund {figure} to the client?</p>
          <p className="text-muted">
            It goes back to the card or account they paid with. This can&apos;t be undone,
            and ChairBack doesn&apos;t message them about it.
          </p>
          <input
            data-qa="deposit-refund-note"
            aria-label="Reason (optional, for your records)"
            className={cn(INPUT, "h-10 text-xs")}
            placeholder="Reason (optional, for your records)"
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button"
              data-qa="deposit-refund-confirm"
              disabled={pending}
              onClick={() => void submit()}
              className="flex h-10 flex-1 items-center justify-center rounded-xl bg-danger-soft px-4 text-xs font-semibold text-charcoal-900 transition-opacity duration-150 disabled:opacity-60"
            >
              {pending ? "Refunding…" : `Refund ${figure}`}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setConfirming(false);
                setMessage(null);
              }}
              className="flex h-10 flex-1 items-center justify-center rounded-xl border border-subtle px-4 text-xs text-muted"
            >
              Keep it
            </button>
          </div>
        </div>
      )}

      {message && (
        <p role="alert" data-qa="deposit-refund-message" className="mt-3 text-xs text-danger-soft">
          {message}
        </p>
      )}
    </section>
  );
}
