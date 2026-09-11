"use client";

import { useState } from "react";

/**
 * "Why?" for a manual punch change - a bonus, an undo, an edit.
 *
 * Every manual adjustment to a client's punches now records who made it and
 * why (the API refuses one without a reason). The common reasons are one tap;
 * anything else is a short line of text. What's written here is for the shop's
 * own history only - the client never sees it.
 */
export function ReasonPicker({
  prompt,
  presets,
  busy,
  onPick,
  onCancel,
}: {
  prompt: string;
  presets: string[];
  busy: boolean;
  onPick: (reason: string) => void;
  onCancel: () => void;
}) {
  const [other, setOther] = useState<string | null>(null);
  const trimmed = (other ?? "").trim();

  return (
    <div className="mt-2 space-y-2">
      <p className="text-[11px] text-muted">{prompt}</p>
      {other === null ? (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              disabled={busy}
              onClick={() => onPick(p)}
              className="rounded-full border border-subtle px-3 py-1 text-[11px] text-offwhite transition-colors duration-150 ease-out hover:border-gold/50 hover:text-gold disabled:opacity-50"
            >
              {p}
            </button>
          ))}
          <button
            type="button"
            disabled={busy}
            onClick={() => setOther("")}
            className="rounded-full border border-subtle px-3 py-1 text-[11px] text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
          >
            Other…
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="px-2 py-1 text-[11px] text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      ) : (
        <form
          className="flex items-center gap-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (trimmed.length >= 2) onPick(trimmed);
          }}
        >
          <input
            autoFocus
            value={other}
            maxLength={200}
            onChange={(ev) => setOther(ev.target.value)}
            placeholder="A few words for your records"
            aria-label="Reason"
            className="min-w-0 flex-1 rounded-lg border border-subtle bg-charcoal-700 px-2 py-1 text-sm text-offwhite outline-none focus:border-gold/50"
          />
          <button
            type="submit"
            disabled={busy || trimmed.length < 2}
            className="rounded-full bg-gold px-3 py-1 text-[11px] font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-50"
          >
            {busy ? "…" : "Save"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setOther(null)}
            className="text-[11px] text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
          >
            Back
          </button>
        </form>
      )}
    </div>
  );
}
