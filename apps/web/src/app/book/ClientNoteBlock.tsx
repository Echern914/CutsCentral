import { clientNoteHeading, normalizeClientNote } from "@chairback/config/clientNote";

/**
 * The shop's note for clients ("Please arrive 10 minutes early"), as the booked
 * screen and the appointment page show it. One component so the two read
 * alike - and the emails use the same heading (config/clientNote.ts).
 *
 * 🔴 TEXT, NEVER MARKUP: the owner's words render as a React string, line
 * breaks kept by CSS. Nothing when there is no note.
 */
export function ClientNoteBlock({ shopName, note }: { shopName: string; note: string | null | undefined }) {
  const text = normalizeClientNote(note);
  if (!text) return null;
  return (
    <div
      data-testid="client-note"
      className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-left"
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide opacity-60">
        {clientNoteHeading(shopName)}
      </p>
      <p className="mt-1 whitespace-pre-line text-sm [overflow-wrap:anywhere]">{text}</p>
    </div>
  );
}
