"use client";

import { useState } from "react";
import {
  BOOKING_CHECKLIST_LINE_MAX,
  BOOKING_CHECKLIST_MAX_LINES,
  BOOKING_POLICY_TEXT_MAX,
  normalizeBookingPolicy,
} from "@chairback/config/bookingPolicy";
import { Card, CardHeader } from "@/components/ui/Card";
import { saveBookingPolicyAction } from "./actions";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * YOUR POLICIES - what a customer reads, and ticks, before they can book.
 *
 * The owner writes it in their own words: a few paragraphs of policy, and up
 * to eight short lines the customer must tick on the booking page's last step
 * ("I'll arrive 5 minutes early"). Confirm stays disabled until every line is
 * ticked, the API refuses a booking that skips it, and what was agreed is
 * frozen onto the appointment.
 *
 * Blank is OFF, and nothing changes for the shop - said on the card, because
 * a required checkbox costs bookings the same way a required question does.
 */

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";

export function BookingPolicyCard({
  initialText,
  initialChecklist,
  toast,
}: {
  initialText: string | null;
  initialChecklist: string[];
  toast: Toast;
}) {
  const [text, setText] = useState(initialText ?? "");
  const [lines, setLines] = useState<string[]>(initialChecklist);
  const [draft, setDraft] = useState("");
  // What the server last accepted - Save is live only when something differs.
  const [saved, setSaved] = useState(() =>
    JSON.stringify(normalizeBookingPolicy({ text: initialText, checklist: initialChecklist })),
  );
  // Our own flag: useTransition's pending does not span the await (React 18).
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"saved" | "failed" | null>(null);

  const cleaned = normalizeBookingPolicy({ text, checklist: lines });
  const dirty = JSON.stringify(cleaned) !== saved;
  const full = lines.length >= BOOKING_CHECKLIST_MAX_LINES;

  function edit<T>(set: (v: T) => void, v: T) {
    set(v);
    setStatus(null);
  }

  function addLine() {
    const line = draft.trim();
    if (!line || full) return;
    edit(setLines, [...lines, line]);
    setDraft("");
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setStatus(null);
    const r = await saveBookingPolicyAction({
      bookingPolicyText: cleaned.text,
      bookingPolicyChecklist: cleaned.checklist,
    });
    setSaving(false);
    if (!r.ok) {
      setStatus("failed");
      toast("Couldn't save your policies.", "error");
      return;
    }
    setSaved(JSON.stringify(cleaned));
    setText(cleaned.text ?? "");
    setLines(cleaned.checklist);
    setStatus("saved");
    toast("Policies saved.", "success");
  }

  return (
    <Card id="booking-policies" className="p-5">
      <CardHeader
        title="Your policies"
        subtitle="Shown on the last step of your booking page, above Confirm. Leave both blank to show nothing."
      />

      <label className="mt-4 block text-xs font-medium uppercase tracking-[0.14em] text-muted" htmlFor="booking-policy-text">
        Policy
      </label>
      <textarea
        id="booking-policy-text"
        className={`${field} mt-1.5 min-h-[120px] resize-y`}
        value={text}
        maxLength={BOOKING_POLICY_TEXT_MAX}
        onChange={(e) => edit(setText, e.target.value)}
        placeholder={
          "Deposits, lateness, no-shows, what to bring - in your own words.\nCustomers can read the whole thing before they book."
        }
      />
      <p className="mt-1 text-right text-xs text-muted">
        {text.length}/{BOOKING_POLICY_TEXT_MAX}
      </p>

      <p className="mt-3 text-xs font-medium uppercase tracking-[0.14em] text-muted">
        Checklist
      </p>
      <p className="mt-1 text-xs text-muted">
        Each line is a box the customer must tick before Confirm works. Every
        line you add is one more step between someone and their booking, so keep
        it to what really matters.
      </p>

      {lines.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {lines.map((line, i) => (
            <li key={i} className="flex min-w-0 items-center gap-2">
              {/* Two rows, so a long line can be read whole on a phone
                  before it is saved. One line is one box: no line breaks. */}
              <textarea
                className={`${field} min-w-0 flex-1 resize-none`}
                rows={2}
                value={line}
                maxLength={BOOKING_CHECKLIST_LINE_MAX}
                aria-label={`Checklist line ${i + 1}`}
                onChange={(e) =>
                  edit(
                    setLines,
                    lines.map((l, j) => (j === i ? e.target.value.replace(/\s*\n\s*/g, " ") : l)),
                  )
                }
              />
              <button
                type="button"
                onClick={() => edit(setLines, lines.filter((_, j) => j !== i))}
                className="min-h-11 shrink-0 px-2 text-xs font-medium text-muted transition-colors hover:text-danger-soft"
                aria-label={`Remove checklist line ${i + 1}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {full ? (
        <p className="mt-2 text-xs text-muted">
          That&apos;s the most lines a customer is asked to tick ({BOOKING_CHECKLIST_MAX_LINES}).
        </p>
      ) : (
        <div className="mt-2 flex min-w-0 items-center gap-2">
          <input
            className={`${field} min-w-0 flex-1`}
            value={draft}
            maxLength={BOOKING_CHECKLIST_LINE_MAX}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addLine();
              }
            }}
            placeholder="I'll arrive 5 minutes early"
            aria-label="New checklist line"
          />
          <button
            type="button"
            onClick={addLine}
            disabled={!draft.trim()}
            className="min-h-11 shrink-0 rounded-xl border border-subtle px-4 text-sm font-medium text-offwhite transition-colors hover:border-subtle-strong disabled:opacity-50"
          >
            Add
          </button>
        </div>
      )}

      {/* Outcome right above the button, where the eye already is. */}
      {status && (
        <p
          role="status"
          className={`mt-4 text-sm ${status === "saved" ? "text-emerald-soft" : "text-danger-soft"}`}
        >
          {status === "saved"
            ? cleaned.text || cleaned.checklist.length
              ? "Saved. Your booking page shows this now."
              : "Saved. Your booking page shows no policies."
            : "Couldn't save. Check your connection and try again."}
        </p>
      )}
      <button
        type="button"
        onClick={() => void save()}
        disabled={!dirty || saving}
        className="mt-3 min-h-11 w-full rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50 sm:w-auto"
      >
        {saving ? "Saving…" : "Save policies"}
      </button>
    </Card>
  );
}
