"use client";

import { useState } from "react";
import { CLIENT_NOTE_MAX, clientNoteHeading, normalizeClientNote } from "@chairback/config/clientNote";
import { Card, CardHeader } from "@/components/ui/Card";
import { saveClientNoteAction } from "./actions";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * NOTE FOR CLIENTS - a line or two on every confirmation. A barber: "if we
 * could add notes to the confirmations. Like I would tell people please arrive
 * 10 minutes early."
 *
 * Shown on the booked screen, the client's appointment page and the
 * confirmation and reminder emails - and the card says where, and that texts
 * don't carry it, so nobody expects it in a message it isn't in. A preview
 * shows it the way clients will read it. Blank shows nothing anywhere.
 */

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";

export function ClientNoteCard({
  shopName,
  initialNote,
  toast,
}: {
  shopName: string;
  initialNote: string | null;
  toast: Toast;
}) {
  const [text, setText] = useState(initialNote ?? "");
  const [saved, setSaved] = useState(() => normalizeClientNote(initialNote));
  // Our own flag: useTransition's pending does not span the await (React 18).
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"saved" | "failed" | null>(null);

  const cleaned = normalizeClientNote(text);
  const dirty = cleaned !== saved;

  async function save() {
    if (saving) return;
    setSaving(true);
    setStatus(null);
    const r = await saveClientNoteAction(cleaned);
    setSaving(false);
    if (!r.ok) {
      setStatus("failed");
      toast("Couldn't save your note.", "error");
      return;
    }
    setSaved(cleaned);
    setText(cleaned ?? "");
    setStatus("saved");
    toast("Note saved.", "success");
  }

  return (
    <Card id="client-note" className="p-5">
      <CardHeader
        title="Note for clients"
        subtitle="Shown on every booking confirmation: the booked screen, their appointment page, and the confirmation and reminder emails. Not in text messages. Leave blank to show nothing."
      />

      <label
        className="mt-4 block text-xs font-medium uppercase tracking-[0.14em] text-muted"
        htmlFor="client-note-text"
      >
        Note
      </label>
      <textarea
        id="client-note-text"
        className={`${field} mt-1.5 min-h-[88px] resize-y`}
        value={text}
        maxLength={CLIENT_NOTE_MAX}
        onChange={(e) => {
          setText(e.target.value);
          setStatus(null);
        }}
        placeholder="Please arrive 10 minutes early. Parking is around the back."
      />
      <p className="mt-1 text-right text-xs text-muted">
        {text.length}/{CLIENT_NOTE_MAX}
      </p>

      {cleaned && (
        <div data-testid="client-note-preview" className="mt-2 rounded-xl border border-subtle bg-charcoal-900/60 p-3">
          <p className="text-[11px] uppercase tracking-wide text-muted">{clientNoteHeading(shopName)}</p>
          {/* whitespace-pre-line: their line breaks, as text - never markup. */}
          <p className="mt-1 whitespace-pre-line text-sm text-offwhite [overflow-wrap:anywhere]">{cleaned}</p>
        </div>
      )}

      {status && (
        <p
          role="status"
          className={`mt-4 text-sm ${status === "saved" ? "text-emerald-soft" : "text-danger-soft"}`}
        >
          {status === "saved"
            ? cleaned
              ? "Saved. New confirmations carry this now."
              : "Saved. Confirmations show no note."
            : "Couldn't save. Check your connection and try again."}
        </p>
      )}
      <button
        type="button"
        onClick={() => void save()}
        disabled={!dirty || saving}
        className="mt-3 min-h-11 w-full rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50 sm:w-auto"
      >
        {saving ? "Saving…" : "Save note"}
      </button>
    </Card>
  );
}
