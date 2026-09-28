"use client";

import { useState } from "react";
import type { BookingPolicyData } from "./page";

/**
 * "BEFORE YOU BOOK" - the shop's own policies, and the lines a customer ticks
 * before Confirm works.
 *
 * Shared by the single booking page and the group page, so both ask the same
 * way. The API enforces it too (engines/bookingPolicy.ts): this component is
 * what makes the rule visible, never what makes it true.
 *
 * 🔴 EVERY BOX STARTS UNTICKED, and only the customer's own tap ticks one. A
 * pre-ticked box is not agreement, it is the shop agreeing on their behalf.
 */

/** Past this, the policy text starts folded so the checklist stays in reach. */
const FOLD_AT_CHARS = 320;

/**
 * The page's state for one policy: which boxes are ticked, whether all are,
 * and the version to send. `replace` swaps in a policy the API says is newer
 * (a 409 POLICY_CHANGED) and clears every tick - the customer has to read and
 * tick the new words, not inherit ticks given to the old ones.
 */
export function useBookingPolicy(initial: BookingPolicyData | null | undefined) {
  const [policy, setPolicy] = useState<BookingPolicyData | null>(initial ?? null);
  const [ticked, setTicked] = useState<boolean[]>(() =>
    (initial?.checklist ?? []).map(() => false),
  );
  const lines = policy?.checklist ?? [];
  const complete = lines.length === 0 || (ticked.length === lines.length && ticked.every(Boolean));
  return {
    policy,
    ticked,
    complete,
    /** Sent with the booking only when there is something to agree to. */
    acceptedVersion: policy && lines.length > 0 ? policy.version : undefined,
    toggle(i: number) {
      setTicked((prev) => prev.map((v, j) => (j === i ? !v : v)));
    },
    replace(next: BookingPolicyData | null) {
      setPolicy(next);
      setTicked((next?.checklist ?? []).map(() => false));
    },
  };
}

/** Accept only a well-formed policy from an untyped 409 body. */
export function readBookingPolicy(raw: unknown): BookingPolicyData | null {
  if (!raw || typeof raw !== "object") return null;
  const { text, checklist, version } = raw as Record<string, unknown>;
  if (typeof version !== "string" || !Array.isArray(checklist)) return null;
  return {
    text: typeof text === "string" ? text : null,
    checklist: checklist.filter((l): l is string => typeof l === "string"),
    version,
  };
}

/** What the page says when a newer policy arrives mid-booking. */
export const POLICY_CHANGED_MESSAGE =
  "The shop just updated its policies. Please read them and tick each line again.";
/** Under the Confirm button while a box is still empty. */
export const POLICY_HINT = "Tick each line under “Before you book” to confirm.";

export function BookingPolicyPanel({
  policy,
  ticked,
  onToggle,
  moneyLines = [],
  accent,
}: {
  policy: BookingPolicyData;
  ticked: boolean[];
  onToggle: (i: number) => void;
  /** The shop's payment and cancellation terms, already in words. */
  moneyLines?: string[];
  /** The shop's accent, for the checkboxes. */
  accent?: string;
}) {
  const long = (policy.text?.length ?? 0) > FOLD_AT_CHARS;
  const [open, setOpen] = useState(false);
  const folded = long && !open;

  return (
    <section
      aria-labelledby="before-you-book"
      data-qa="booking-policy"
      className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-white/10 px-3 py-3"
    >
      <h3 id="before-you-book" className="text-sm font-semibold text-offwhite">
        Before you book
      </h3>

      {policy.text && (
        <div className="min-w-0">
          <p
            id="booking-policy-text"
            className={
              "whitespace-pre-line text-xs leading-relaxed text-muted [overflow-wrap:anywhere]" +
              (folded ? " max-h-24 overflow-hidden" : "")
            }
          >
            {policy.text}
          </p>
          {long && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls="booking-policy-text"
              className="mt-1 min-h-11 text-xs font-medium text-offwhite underline"
            >
              {open ? "Show less" : "Read the full policy"}
            </button>
          )}
        </div>
      )}

      {moneyLines.map((line) => (
        <p key={line} className="text-xs text-muted [overflow-wrap:anywhere]">
          {line}
        </p>
      ))}

      {policy.checklist.length > 0 && (
        <ul className="flex flex-col gap-1">
          {policy.checklist.map((line, i) => (
            <li key={`${i}-${line}`}>
              {/* The whole row is the tap target - a 16px box alone is too
                  small a thing to hit reliably with a thumb. */}
              <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg py-1.5 text-sm text-offwhite">
                <input
                  type="checkbox"
                  checked={ticked[i] ?? false}
                  onChange={() => onToggle(i)}
                  className="mt-0.5 h-5 w-5 shrink-0"
                  style={accent ? { accentColor: accent } : undefined}
                />
                <span className="min-w-0 [overflow-wrap:anywhere]">{line}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The shop's money terms as two plain lines, from the SAME shared sentences
 * the receptionist speaks (config/shopPolicy.ts, sent by the API). Only when
 * a payment is actually taken at booking - otherwise the API sends no
 * cancellation line, and a "free cancellation" sentence could contradict the
 * shop's own written policy right above it.
 */
export function moneyTermsLines(
  payment: { collects: "payment" | "card" | null; sentence: string; cancellation?: string | null } | null | undefined,
): string[] {
  if (!payment || payment.collects !== "payment" || !payment.cancellation) return [];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return [`Payment: ${cap(payment.sentence)}.`, `Cancelling: ${cap(payment.cancellation)}.`];
}
