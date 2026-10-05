"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { INPUT } from "./formkit";
import { refundTipAction } from "./actions";
import { explainDepositRefund } from "./DepositRefund";

/**
 * REFUND A TIP the client left online after the visit.
 *
 * The same two presses and the same honesty as Refund deposit
 * (DepositRefund.tsx): the first tap moves nothing, the confirm restates the
 * figure, the figure sent is the SERVER's, an unknown answer is never
 * "nothing was refunded", and the outcome goes to the sheet's footer, never a
 * toast a phone cannot see.
 *
 * One thing the deposit button never has to say: Stripe's fee on the tip is
 * not given back. The client gets the whole tip; the shop's balance carries
 * the fee, as at any card reader (Eric, 2026-10-05). Said before the press.
 */

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function TipRefund({
  appointmentId,
  tip,
  onRefunded,
  onStale,
}: {
  appointmentId: string;
  tip: { refundableCents: number; feeCents: number };
  /** Money went back: say so in the footer, re-read the booking and the agenda. */
  onRefunded: (message: string) => void;
  /** The server's figure moved: re-read the booking so the button shows it. */
  onStale: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  const figure = money(tip.refundableCents);

  function finish(text: string) {
    setConfirming(false);
    setNote("");
    setDone(true);
    onRefunded(text);
  }

  async function submit() {
    if (pending) return;
    setMessage(null);
    setPending(true);
    try {
      let res: Awaited<ReturnType<typeof refundTipAction>>;
      try {
        res = await refundTipAction(appointmentId, {
          amountCents: tip.refundableCents,
          ...(note.trim() ? { note: note.trim() } : {}),
        });
      } catch {
        setMessage(explainDepositRefund("unconfirmed", undefined));
        return;
      }
      if (res.ok) {
        finish(
          res.result === "already_refunded"
            ? "This tip had already been refunded."
            : res.status === "pending"
              ? `Refund of the ${money(res.amountCents ?? tip.refundableCents)} tip sent. Stripe is still processing it.`
              : `Refunded the ${money(res.amountCents ?? tip.refundableCents)} tip to the client.`,
        );
        return;
      }
      if (res.error === "nothing_to_refund") {
        finish("This tip had already been refunded.");
        return;
      }
      setMessage(explainDepositRefund(res.error, res.reason));
      if (res.error === "amount_changed") onStale();
    } finally {
      setPending(false);
    }
  }

  if (done) return null;

  return (
    <section
      data-qa="tip-refund"
      className="min-w-0 rounded-2xl border border-subtle bg-charcoal-800/40 p-3.5 sm:p-4"
    >
      <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-gold/80">Tip</h3>
      {!confirming && (
        <button
          type="button"
          data-qa="tip-refund-open"
          onClick={() => {
            setMessage(null);
            setConfirming(true);
          }}
          className="flex h-10 w-full items-center justify-center rounded-xl border border-danger-soft/40 px-4 text-xs font-medium text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/10"
        >
          Refund tip {figure}
        </button>
      )}

      {confirming && (
        <div className="flex flex-col gap-2 rounded-xl border border-danger-soft/30 bg-danger-soft/5 p-3 text-xs">
          <p className="text-sm text-offwhite">Refund the {figure} tip to the client?</p>
          <p className="text-muted">
            It goes back to the card or account they paid with. Stripe&apos;s {money(tip.feeCents)} fee
            isn&apos;t returned, so it comes out of your balance. This can&apos;t be undone, and ChairBack
            doesn&apos;t message them about it.
          </p>
          <input
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
              data-qa="tip-refund-confirm"
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
        <p role="alert" data-qa="tip-refund-message" className="mt-3 text-xs text-danger-soft">
          {message}
        </p>
      )}
    </section>
  );
}
