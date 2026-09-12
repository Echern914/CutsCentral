"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { adjustPunchAction, reversePunchAction } from "../../actions";
import { ReasonPicker } from "./ReasonPicker";

/** The common reasons, one tap each; "Other…" takes a few words. */
const UNDO_REASONS = ["Given by mistake", "Wrong client", "Visit didn't happen"];
const EDIT_REASONS = ["Counted wrong", "Service changed"];

export interface LedgerEntry {
  id: string;
  at: string;
  earned: number;
  redeemed: number;
  runningBalance: number;
  note: string | null;
  /** Who made a manual entry (null for the system's own, and older history). */
  by?: string | null;
  /** Why, in their words - the shop's own trail, never shown to the client. */
  reason?: string | null;
  /** Which punch card this entry sits on; null = the shop's default card. */
  card: { id: string; name: string; emoji: string | null; accentColor: string | null } | null;
  reversed: boolean;
  isCorrection: boolean;
  editable: boolean;
}

function fmt(d: string) {
  return new Date(d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** How an undo/adjust failure maps to a human message. The server returns the
 *  reason in `error`; anything else (race, network) falls back to generic. */
function reasonText(error: string | undefined): string {
  switch (error) {
    case "already_reversed":
      return "That entry was already undone.";
    case "is_a_correction":
      return "You can't undo a correction. Add a punch instead.";
    case "not_an_earn":
      return "Only earned punches can be edited.";
    case "would_go_negative":
      return "Those punches were already spent on a reward.";
    case "entry_not_found":
      return "That entry no longer exists.";
    default:
      return "Couldn't update that entry.";
  }
}

/**
 * Punch history with per-entry barber controls. The barber is their own admin
 * over their clients' punches: any earned/bonus/redeemed entry they shouldn't
 * have given can be undone (writes an offsetting correction, preserving the
 * trail), and an earn can be re-counted. Reversed originals and correction rows
 * are shown but marked, so the history stays honest.
 */
export function PunchHistory({
  clientId,
  entries,
}: {
  clientId: string;
  entries: LedgerEntry[];
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  // id of the entry whose "Undo?" confirm is open, or whose edit field is open.
  const [confirmUndoId, setConfirmUndoId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>("");

  function undo(entry: LedgerEntry, reason: string) {
    startTransition(async () => {
      const r = await reversePunchAction(clientId, entry.id, reason);
      setConfirmUndoId(null);
      if (r.ok) toast("Punch undone", "success");
      else toast(reasonText(r.error), "error");
    });
  }

  function openEdit(entry: LedgerEntry) {
    setEditingId(entry.id);
    setEditValue(String(entry.earned));
    setConfirmUndoId(null);
  }

  /** A valid new count, or null (after saying why not). */
  function editedCount(entry: LedgerEntry): number | null {
    const punches = Number(editValue);
    if (!Number.isInteger(punches) || punches < 1 || punches > 20) {
      toast("Enter a whole number from 1 to 20.", "error");
      return null;
    }
    if (punches === entry.earned) {
      setEditingId(null);
      return null;
    }
    return punches;
  }

  function saveEdit(entry: LedgerEntry, reason: string) {
    const punches = editedCount(entry);
    if (punches === null) return;
    startTransition(async () => {
      const r = await adjustPunchAction(clientId, entry.id, punches, reason);
      setEditingId(null);
      if (r.ok) toast("Punch count updated", "success");
      else toast(reasonText(r.error), "error");
    });
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-subtle px-5 py-3">
        <h2 className="font-display text-lg">Punch history</h2>
      </div>
      {entries.length === 0 ? (
        <p className="px-5 py-5 text-sm text-muted">No punch activity yet.</p>
      ) : (
        <ul className="max-h-96 divide-y divide-subtle overflow-y-auto">
          {entries.map((e) => {
            const dimmed = e.reversed || e.isCorrection;
            const isEditing = editingId === e.id;
            const isConfirming = confirmUndoId === e.id;
            return (
              <li key={e.id} className="px-5 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span
                    className={`text-sm ${dimmed ? "text-muted" : "text-offwhite"} ${
                      e.reversed ? "line-through decoration-muted" : ""
                    }`}
                  >
                    {e.earned > 0 ? `+${e.earned} earned` : ""}
                    {e.redeemed > 0 ? `-${e.redeemed} redeemed` : ""}
                    {e.note ? (
                      <span className="ml-2 text-xs text-muted">({e.note})</span>
                    ) : null}
                    {e.card && (
                      <span
                        className="ml-2 rounded-full border border-subtle px-2 py-0.5 text-[10px] uppercase tracking-wide"
                        style={{ color: e.card.accentColor ?? "#D4AF37" }}
                      >
                        {e.card.emoji ? `${e.card.emoji} ` : ""}
                        {e.card.name}
                      </span>
                    )}
                    {e.reversed && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-danger-soft">
                        undone
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-muted">
                    bal {e.runningBalance} · {fmt(e.at)}
                  </span>
                </div>
                {/* Who and why, for a manual change - the shop's own trail. */}
                {e.by || e.reason ? (
                  <p className="mt-0.5 text-[11px] text-muted">
                    {[e.by ? `by ${e.by}` : null, e.reason].filter(Boolean).join(" · ")}
                  </p>
                ) : null}

                {/* Controls: only on live (not reversed, not a correction) rows. */}
                {!dimmed && !isEditing && !isConfirming && (
                  <div className="mt-1.5 flex gap-3">
                    <button
                      onClick={() => {
                        // Mirror openEdit closing the undo confirm: opening a
                        // confirm closes any edit field open on another row, so
                        // only one interaction panel is ever visible at a time.
                        setEditingId(null);
                        setConfirmUndoId(e.id);
                      }}
                      disabled={pending}
                      className="text-[11px] text-muted underline-offset-2 transition-colors duration-150 ease-out hover:text-danger-soft hover:underline disabled:opacity-50"
                    >
                      Undo
                    </button>
                    {e.editable && (
                      <button
                        onClick={() => openEdit(e)}
                        disabled={pending}
                        className="text-[11px] text-muted underline-offset-2 transition-colors duration-150 ease-out hover:text-gold hover:underline disabled:opacity-50"
                      >
                        Edit count
                      </button>
                    )}
                  </div>
                )}

                {/* Undo: choosing the reason IS the confirmation. */}
                {isConfirming && (
                  <ReasonPicker
                    prompt={`Why undo this ${e.redeemed > 0 ? "redemption" : "punch"}?`}
                    presets={UNDO_REASONS}
                    busy={pending}
                    onPick={(reason) => undo(e, reason)}
                    onCancel={() => setConfirmUndoId(null)}
                  />
                )}

                {/* Edit count, then why. */}
                {isEditing && (
                  <div className="mt-2">
                    <div className="flex items-center gap-2">
                      <label className="text-[11px] text-muted" htmlFor={`count-${e.id}`}>
                        Punches earned
                      </label>
                      <input
                        id={`count-${e.id}`}
                        type="number"
                        min={1}
                        max={20}
                        value={editValue}
                        onChange={(ev) => setEditValue(ev.target.value)}
                        className="w-16 rounded-lg border border-subtle bg-charcoal-700 px-2 py-1 text-sm text-offwhite outline-none focus:border-gold/50"
                      />
                    </div>
                    <ReasonPicker
                      prompt="Why change it?"
                      presets={EDIT_REASONS}
                      busy={pending}
                      onPick={(reason) => saveEdit(e, reason)}
                      onCancel={() => setEditingId(null)}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
