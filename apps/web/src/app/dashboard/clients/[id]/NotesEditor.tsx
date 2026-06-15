"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { saveNotesAction } from "../../actions";

/** Private barber notes on a client - autosave on blur / explicit save. */
export function NotesEditor({
  clientId,
  initial,
}: {
  clientId: string;
  initial: string;
}) {
  const { toast } = useToast();
  const [notes, setNotes] = useState(initial);
  const [pending, startTransition] = useTransition();
  const dirty = notes !== initial;

  function save() {
    startTransition(async () => {
      const r = await saveNotesAction(clientId, notes);
      toast(r.ok ? "Notes saved" : "Could not save notes", r.ok ? "success" : "error");
    });
  }

  return (
    <Card className="p-5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-display text-lg">Notes</h2>
        <button
          onClick={save}
          disabled={!dirty || pending}
          className="rounded-full bg-gold px-4 py-1.5 text-xs font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-40"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={4}
        placeholder="Private notes: preferences, history, anything useful."
        className="w-full resize-none rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50"
      />
    </Card>
  );
}
