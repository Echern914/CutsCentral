"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { INPUT } from "./formkit";
import {
  getCheckoutAction,
  refundCheckoutPaymentAction,
  type CheckoutRefundable,
} from "./actions";

/**
 * REFUND A CHECKOUT CARD PAYMENT, FROM CHAIRBACK.
 *
 * 🔴 THE MISTAKE THIS REPLACES. A Tap to Pay or saved-card checkout is a
 * destination charge. The barber's own Stripe dashboard shows only a copy of
 * the payment, and refunding that copy takes the money back OUT OF THE
 * BARBER'S account while the customer is refunded nothing - and Stripe labels
 * the copy "refunded", so nobody notices. It happened on the very first live
 * Tap to Pay payment. This button refunds the real charge.
 *
 * Two presses, never one: open, then confirm with the exact figure stated
 * again. Nothing here can move money on the first tap, and a refund cannot be
 * undone.
 */

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

type Toast = (msg: string, kind?: "success" | "error") => void;

/** What each refusal means for the person holding the phone. */
function explain(error: string | undefined, reason: string | undefined): string {
  switch (error) {
    // 🔴 NOT "finish it in Stripe". The only dashboard that can refund the real
    // charge is ChairBack's platform account, which a shop cannot open - and the
    // shop's OWN Stripe account shows only a copy, where "Refund" takes the money
    // back from the shop and gives the customer nothing. So the honest next step
    // is a person at ChairBack, plus a warning about the trap.
    case "refund_in_stripe":
      return reason === "partially_refunded"
        ? "Part of this payment was already refunded outside ChairBack. Contact ChairBack support to finish it - refunding from your own Stripe account won't reach the customer."
        : "Part of this payment was already moved back outside ChairBack. Contact ChairBack support to finish this refund, so nothing is taken twice.";
    case "amount_changed":
      return "The amount changed since this opened. Check it again before refunding.";
    case "nothing_to_refund":
      return "There is nothing left to refund on this payment.";
    case "not_refundable":
      return reason === "unconfirmed_charge"
        ? "This payment is still being confirmed. Try again in a few minutes."
        : "This payment was never collected, so there is nothing to refund.";
    case "refund_refused":
      return "Stripe refused the refund. Nothing was refunded.";
    case "stripe_unavailable":
    case "network_error":
      return "Couldn't reach Stripe. Nothing was refunded - try again.";
    case "unconfirmed":
      return "We couldn't confirm the refund yet. Pressing Refund again is safe - it can't refund twice.";
    default:
      return "That didn't work. Nothing was refunded.";
  }
}

export function CheckoutRefund({
  appointmentId,
  toast,
  onRefunded,
}: {
  appointmentId: string;
  toast: Toast;
  /** The sheet and the agenda need re-reading once money moved. */
  onRefunded: () => void;
}) {
  const [payments, setPayments] = useState<CheckoutRefundable[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  // A plain flag, not useTransition: the refund is one awaited call, and the
  // button must stay disabled for exactly as long as it is in flight.
  const [pending, setPending] = useState(false);

  const load = useCallback(() => {
    let alive = true;
    void (async () => {
      const res = await getCheckoutAction(appointmentId);
      if (!alive) return;
      // Owners and managers only; anyone else gets no data and sees no button.
      setPayments(res.ok ? (res.data?.refunds ?? []) : []);
    })();
    return () => {
      alive = false;
    };
  }, [appointmentId]);
  useEffect(load, [load]);

  const shown = (payments ?? []).filter((p) => p.collectedCents > 0);
  if (shown.length === 0) return null;

  async function submit(p: CheckoutRefundable) {
    if (pending) return;
    setMessage(null);
    setPending(true);
    try {
      const res = await refundCheckoutPaymentAction(appointmentId, {
        paymentId: p.paymentId,
        amountCents: p.refundableCents,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (res.ok) {
        setConfirming(null);
        setNote("");
        toast(
          res.result === "already_refunded"
            ? "This payment was already refunded"
            : `Refunded ${money(res.amountCents ?? p.refundableCents)}`,
          "success",
        );
        load();
        onRefunded();
        return;
      }
      setMessage(explain(res.error, res.reason));
      // A figure that moved, or a payment that is now fully refunded, is
      // re-read so the screen stops offering what the server refuses.
      if (res.error === "amount_changed" || res.error === "nothing_to_refund") load();
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="min-w-0 rounded-2xl border border-subtle bg-charcoal-800/40 p-3.5 sm:p-4">
      <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-gold/80">
        Refund
      </h3>
      <ul className="flex flex-col gap-3">
        {shown.map((p) => {
          const cardLabel = p.card
            ? `${p.card.brand} ···· ${p.card.last4}`
            : p.method === "tap_to_pay"
              ? "the card that was tapped"
              : "the saved card";
          const open = confirming === p.paymentId;
          return (
            <li key={p.paymentId} className="text-xs">
              <p className="text-muted">
                {p.method === "tap_to_pay" ? "Tap to Pay" : "Saved card"} ·{" "}
                {money(p.collectedCents)}
                {p.refundedCents > 0 && (
                  <span className="text-danger-soft"> · refunded {money(p.refundedCents)}</span>
                )}
              </p>

              {p.refundBlocker === null && !open && (
                <button
                  type="button"
                  data-qa="refund-open"
                  onClick={() => {
                    setMessage(null);
                    setConfirming(p.paymentId);
                  }}
                  className="mt-2 flex h-10 w-full items-center justify-center rounded-xl border border-danger-soft/40 px-4 text-xs font-medium text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/10"
                >
                  Refund {money(p.refundableCents)}
                </button>
              )}

              {p.refundBlocker === null && open && (
                <div className="mt-2 flex flex-col gap-2 rounded-xl border border-danger-soft/30 bg-danger-soft/5 p-3">
                  <p className="text-sm text-offwhite">
                    Refund {money(p.refundableCents)} to {cardLabel}?
                  </p>
                  <p className="text-muted">
                    The money goes back to the card it came from. This can&apos;t be undone.
                  </p>
                  <input
                    data-qa="refund-note"
                    className={cn(INPUT, "h-10 text-xs")}
                    placeholder="Reason (optional, for your records)"
                    maxLength={200}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      data-qa="refund-confirm"
                      disabled={pending}
                      onClick={() => void submit(p)}
                      className="flex h-10 flex-1 items-center justify-center rounded-xl bg-danger-soft px-4 text-xs font-semibold text-charcoal-900 transition-opacity duration-150 disabled:opacity-60"
                    >
                      {pending ? "Refunding…" : `Refund ${money(p.refundableCents)}`}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        setConfirming(null);
                        setMessage(null);
                      }}
                      className="flex h-10 flex-1 items-center justify-center rounded-xl border border-subtle px-4 text-xs text-muted"
                    >
                      Keep payment
                    </button>
                  </div>
                </div>
              )}

              {p.refundBlocker === "partially_refunded" && (
                <p className="mt-1.5 text-muted">{explain("refund_in_stripe", "partially_refunded")}</p>
              )}
              {p.refundBlocker === "unconfirmed_charge" && (
                <p className="mt-1.5 text-muted">{explain("not_refundable", "unconfirmed_charge")}</p>
              )}
            </li>
          );
        })}
      </ul>
      {message && (
        <p role="alert" data-qa="refund-message" className="mt-3 text-xs text-danger-soft">
          {message}
        </p>
      )}
    </section>
  );
}
