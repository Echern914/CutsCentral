"use client";

import { useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { endPairingAction, pairMentorAction } from "./actions";

/** One pairing as the owner sees it: who and since when - never numbers. */
export interface Pairing {
  id: string;
  mentor: { linkId: string; name: string };
  student: { linkId: string; name: string };
  since: string;
}

/**
 * Mentorship on the owner's Team card: pair a mentor with a student, see the
 * pairs, end one.
 *
 * The owner never sees what a student shares with their mentor here - only
 * that the pairing exists. The student decides what the mentor sees, starting
 * from nothing (Teams page). Photo feedback stays in the team's own chat.
 */
export function MentorPairs({
  members,
  pairings,
  onChanged,
}: {
  members: { linkId: string; name: string }[];
  pairings: Pairing[];
  /** Re-read the team after a change - the server is the source of truth. */
  onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [mentor, setMentor] = useState("");
  const [student, setStudent] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function pair() {
    if (!mentor || !student) return;
    if (mentor === student) {
      toast("Pick two different people", "error");
      return;
    }
    setBusy("pair");
    const res = await pairMentorAction(mentor, student);
    await onChanged();
    if (res.ok) {
      const name = (id: string) => members.find((m) => m.linkId === id)?.name ?? "";
      toast(`${name(mentor)} now mentors ${name(student)}`, "success");
      setMentor("");
      setStudent("");
    } else {
      toast(
        res.error === "already_paired"
          ? "They're already paired"
          : res.error === "not_found"
            ? "One of them isn't on the team any more"
            : "Couldn't pair them - try again",
        "error",
      );
    }
    setBusy(null);
  }

  async function end(p: Pairing) {
    setBusy(p.id);
    const res = await endPairingAction(p.id);
    await onChanged();
    toast(
      res.ok ? `Ended ${p.mentor.name} mentoring ${p.student.name}` : "That had already ended",
      res.ok ? "success" : "error",
    );
    setBusy(null);
  }

  const select =
    "min-h-[40px] w-full min-w-0 rounded-xl border border-subtle bg-charcoal-700 px-3 text-sm text-offwhite outline-none focus:border-gold/50";

  return (
    <section aria-labelledby="team-mentors" data-qa="team-mentors">
      <h3 id="team-mentors" className="text-sm font-medium text-offwhite">
        Mentorship
      </h3>
      <p className="mt-0.5 text-xs text-muted">
        Pair a mentor with someone on the team. The mentor sees only what that person chooses to share with them.
      </p>

      {pairings.length > 0 && (
        <ul className="mt-2 divide-y divide-subtle rounded-xl border border-subtle">
          {pairings.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <p className="min-w-0 text-sm text-offwhite [overflow-wrap:anywhere]">
                {p.mentor.name} <span className="text-muted">mentors</span> {p.student.name}
                <span className="block text-xs text-muted">since {new Date(p.since).toLocaleDateString()}</span>
              </p>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void end(p)}
                className="min-h-[40px] shrink-0 px-2 text-xs text-muted transition-colors hover:text-offwhite disabled:opacity-50"
              >
                {busy === p.id ? "Ending…" : "End"}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <label className="min-w-0">
          <span className="sr-only">Mentor</span>
          <select value={mentor} onChange={(e) => setMentor(e.target.value)} className={select} aria-label="Mentor">
            <option value="">Mentor…</option>
            {members.map((m) => (
              <option key={m.linkId} value={m.linkId}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0">
          <span className="sr-only">Who they mentor</span>
          <select value={student} onChange={(e) => setStudent(e.target.value)} className={select} aria-label="Student">
            <option value="">Who they mentor…</option>
            {members
              .filter((m) => m.linkId !== mentor)
              .map((m) => (
                <option key={m.linkId} value={m.linkId}>
                  {m.name}
                </option>
              ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!mentor || !student || busy !== null}
          onClick={() => void pair()}
          className="min-h-[40px] rounded-full bg-gold px-4 text-xs font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50"
          data-qa="pair-mentor"
        >
          {busy === "pair" ? "Pairing…" : "Pair"}
        </button>
      </div>
    </section>
  );
}
