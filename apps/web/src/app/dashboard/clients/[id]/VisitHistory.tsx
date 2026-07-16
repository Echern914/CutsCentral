"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { deleteVisitAction, editVisitAction } from "../../actions";

export interface VisitRow {
  id: string;
  date: string;
  status: string;
  service: string | null;
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** A Date -> the value an <input type="date"> wants (local YYYY-MM-DD). */
function toDateInput(d: string) {
  const dt = new Date(d);
  const off = dt.getTimezoneOffset() * 60000;
  return new Date(dt.getTime() - off).toISOString().slice(0, 10);
}

/** Map a server failure reason to a human message. */
function reasonText(error: string | undefined): string {
  switch (error) {
    case "would_go_negative":
      return "Those punches were already spent on a reward.";
    case "future_visit":
      return "Visit date can't be in the future.";
    case "not_found":
      return "That visit no longer exists.";
    default:
      return "Couldn't update that visit.";
  }
}

/**
 * Visit history with per-row barber controls. A barber can fix a mis-logged visit
 * (wrong date or service) or delete one that didn't happen. Editing/deleting a
 * COMPLETED visit re-runs or claws back its punches on the server, so the balance
 * stays correct; a change that would drive the balance negative is refused.
 */
export function VisitHistory({
  clientId,
  visits,
}: {
  clientId: string;
  visits: VisitRow[];
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState<string>("");
  const [editService, setEditService] = useState<string>("");

  function openEdit(v: VisitRow) {
    setEditingId(v.id);
    setEditDate(toDateInput(v.date));
    setEditService(v.service ?? "");
    setConfirmDeleteId(null);
  }

  function saveEdit(v: VisitRow) {
    const fields: { when?: string; serviceName?: string | null } = {};
    const origDate = toDateInput(v.date);
    if (editDate && editDate !== origDate) {
      // Send local noon to avoid a timezone day-shift; the server only uses the day.
      fields.when = new Date(`${editDate}T12:00:00`).toISOString();
    }
    const trimmed = editService.trim();
    if (trimmed !== (v.service ?? "")) fields.serviceName = trimmed || null;
    if (fields.when === undefined && fields.serviceName === undefined) {
      setEditingId(null);
      return;
    }
    startTransition(async () => {
      const r = await editVisitAction(clientId, v.id, fields);
      setEditingId(null);
      if (r.ok) toast("Visit updated", "success");
      else toast(reasonText(r.error), "error");
    });
  }

  function remove(v: VisitRow) {
    startTransition(async () => {
      const r = await deleteVisitAction(clientId, v.id);
      setConfirmDeleteId(null);
      if (r.ok) toast("Visit deleted", "success");
      else toast(reasonText(r.error), "error");
    });
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-subtle px-5 py-3">
        <h2 className="font-display text-lg">Visits</h2>
      </div>
      {visits.length === 0 ? (
        <p className="px-5 py-5 text-sm text-muted">No visits yet.</p>
      ) : (
        <ul className="max-h-80 divide-y divide-subtle overflow-y-auto">
          {visits.map((v) => {
            const isEditing = editingId === v.id;
            const isConfirming = confirmDeleteId === v.id;
            return (
              <li key={v.id} className="px-5 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-offwhite">{v.service ?? "Visit"}</span>
                  <span className="shrink-0 text-xs text-muted">
                    {fmtDate(v.date)} · {v.status.toLowerCase()}
                  </span>
                </div>

                {!isEditing && !isConfirming && (
                  <div className="mt-1.5 flex gap-3">
                    <button
                      onClick={() => openEdit(v)}
                      disabled={pending}
                      className="text-[11px] text-muted underline-offset-2 transition-colors duration-150 ease-out hover:text-gold hover:underline disabled:opacity-50"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => {
                        setEditingId(null);
                        setConfirmDeleteId(v.id);
                      }}
                      disabled={pending}
                      className="text-[11px] text-muted underline-offset-2 transition-colors duration-150 ease-out hover:text-danger-soft hover:underline disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                )}

                {isConfirming && (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-[11px] text-muted">
                      Delete this visit? Any punches it earned are removed.
                    </span>
                    <button
                      onClick={() => remove(v)}
                      disabled={pending}
                      className="rounded-full bg-danger-soft/90 px-3 py-1 text-[11px] font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-danger-soft disabled:opacity-50"
                    >
                      {pending ? "…" : "Yes, delete"}
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      disabled={pending}
                      className="text-[11px] text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {isEditing && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      type="date"
                      value={editDate}
                      onChange={(e) => setEditDate(e.target.value)}
                      className="rounded-lg border border-subtle bg-charcoal-700 px-2 py-1 text-sm text-offwhite focus:border-gold/50"
                    />
                    <input
                      type="text"
                      value={editService}
                      onChange={(e) => setEditService(e.target.value)}
                      placeholder="Service"
                      maxLength={120}
                      className="w-40 rounded-lg border border-subtle bg-charcoal-700 px-2 py-1 text-sm text-offwhite focus:border-gold/50"
                    />
                    <button
                      onClick={() => saveEdit(v)}
                      disabled={pending}
                      className="rounded-full bg-gold px-3 py-1 text-[11px] font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-50"
                    >
                      {pending ? "…" : "Save"}
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      disabled={pending}
                      className="text-[11px] text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
                    >
                      Cancel
                    </button>
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
