"use client";

import { useEffect, useRef } from "react";

/**
 * THE REFUSAL A BARBER CAN ANSWER.
 *
 * The API refuses to write over time blocked in the calendar the barber
 * actually manages (Acuity), and says which block, when, and why. This is the
 * one place that refusal is shown - the New appointment form and the edit sheet
 * both render this, so the sentence, the wrapping, the focus behaviour and the
 * two choices are identical wherever a barber meets it.
 *
 * Three rules that are not obvious:
 *
 *  1. THE SENTENCE COMES FROM THE SERVER, VERBATIM, AS TEXT. It names a real
 *     block in the SHOP's timezone; the page cannot rebuild it (it has
 *     instants, not a zone) and must not try. It goes through JSX as a string,
 *     never `dangerouslySetInnerHTML` - a reason is whatever a barber typed
 *     into Acuity, which makes it untrusted input on the way back out.
 *
 *  2. THE CONFIRMATION IS OPAQUE AND BOUND TO THIS CONFLICT. It is the digest
 *     the server sent with THIS refusal; handing it back is what authorises
 *     writing over THESE blocks and nothing else. It is never shown, never
 *     edited, and never invented - if it is missing, the refusal simply is not
 *     confirmable and only the way out is offered.
 *
 *  3. IT TAKES FOCUS. The primary action lives in the dialog's sticky footer,
 *     so the barber may be scrolled well past the top of a long form when the
 *     refusal arrives. A banner he cannot see is a banner that did not happen:
 *     it scrolls itself into view and takes focus, which is also what makes a
 *     screen reader read it.
 */
export interface BlockConflict {
  /** The server's sentence, in the shop's zone. Shown verbatim, as text. */
  reason: string;
  /** The digest that authorises exactly these blocks. Empty = not confirmable. */
  confirmation: string;
}

export function ExternalBlockBanner({
  conflict,
  pending,
  confirmLabel,
  pendingLabel,
  consequence,
  onConfirm,
  onDismiss,
}: {
  conflict: BlockConflict;
  pending: boolean;
  confirmLabel: string;
  pendingLabel: string;
  /** What confirming actually does, in the caller's own words. */
  consequence: string;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Re-runs when the CONFLICT changes, not only when one first appears: a
  // confirmed retry that meets a different block is a new decision, and the
  // barber has to be taken back to it rather than left looking at the footer.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    el.focus();
  }, [conflict.reason, conflict.confirmation]);

  // 🔴 TOKENS, NOT A RAW PALETTE. The first cut of this was amber-200 on
  // amber-400/10 - legible on charcoal and almost invisible on the light
  // theme's warm white. The 320px light screenshot is what caught it. Every
  // colour below is a --cb-* variable that flips with the theme: gold deepens
  // to #9A7A1F on white, `offwhite` and `muted` invert to warm near-black, and
  // the pair stays AA in both.
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alertdialog"
      aria-live="assertive"
      aria-labelledby="block-conflict-title"
      aria-describedby="block-conflict-consequence"
      data-qa="external-block-conflict"
      className="min-w-0 rounded-xl border border-gold/40 bg-gold/10 p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
    >
      {/* [overflow-wrap:anywhere] - a reason is free text from Acuity and can
          be one long unbroken string; at 320px that would push the card wider
          than the dialog and take the buttons off-screen with it. */}
      <p
        id="block-conflict-title"
        className="min-w-0 font-medium text-offwhite [overflow-wrap:anywhere]"
      >
        {conflict.reason}
      </p>
      <p id="block-conflict-consequence" className="mt-1 text-xs leading-relaxed text-muted">
        {consequence}
      </p>
      {/* flex-wrap + min-h-[2.75rem]: two full-size touch targets that drop to
          their own lines rather than clipping when the labels are long. */}
      <div className="mt-3 flex flex-wrap gap-2">
        {conflict.confirmation ? (
          <button
            type="button"
            disabled={pending}
            data-qa="external-block-confirm"
            onClick={onConfirm}
            className="min-h-[2.75rem] flex-none rounded-lg bg-gold px-3 py-2 text-xs font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-50"
          >
            {pending ? pendingLabel : confirmLabel}
          </button>
        ) : null}
        <button
          type="button"
          disabled={pending}
          data-qa="external-block-dismiss"
          onClick={onDismiss}
          className="min-h-[2.75rem] flex-none rounded-lg border border-subtle-strong px-3 py-2 text-xs font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
        >
          Choose another time
        </button>
      </div>
    </div>
  );
}
