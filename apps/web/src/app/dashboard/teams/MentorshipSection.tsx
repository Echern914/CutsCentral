"use client";

import { useState } from "react";
import type { BusinessVocabulary } from "@chairback/config";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { MemberStatGrid } from "@/components/team/MemberStatGrid";
import { SHARE_KEYS, teamStats, type ShareKey, type Sharing, type TeamNumbers } from "@/lib/teamNumbers";
import { endMentorshipAction, setMentorSharingAction } from "./actions";

/** A mentor this member has (they are the student). */
export interface MyMentor {
  id: string;
  mentor: { name: string };
  since: string;
  sharing: Sharing;
  /** Exactly what this mentor reads now. */
  theySee: TeamNumbers;
}

/** A member this member mentors: only what that member shares with them. */
export interface MyStudent {
  id: string;
  student: { name: string };
  since: string;
  numbers: TeamNumbers;
}

/**
 * Mentorship on one team, from a member's side.
 *
 * As a STUDENT: one card per mentor, with the same switches as for the owner -
 * separate ones, all off to start - and the mentor's own view as the preview.
 * As a MENTOR: each member they mentor, read-only, only what that member
 * shares with them. Photo feedback happens in the team's own chat.
 *
 * 🔴 Not optimistic, like the rest of Teams: a switch reads "Saving…" until
 * the server answers, and the preview is the server's answer.
 */
export function MentorshipSection({
  mentors: initialMentors,
  mentoring: initialMentoring,
  vocab,
}: {
  mentors: MyMentor[];
  mentoring: MyStudent[];
  vocab: BusinessVocabulary;
}) {
  const { toast } = useToast();
  const [mentors, setMentors] = useState(initialMentors);
  const [mentoring, setMentoring] = useState(initialMentoring);
  const [saving, setSaving] = useState<string | null>(null);
  const [ending, setEnding] = useState<string | null>(null);

  if (mentors.length === 0 && mentoring.length === 0) return null;

  async function flip(m: MyMentor, key: ShareKey) {
    setSaving(`${m.id}:${key}`);
    const res = await setMentorSharingAction(m.id, { [key]: !m.sharing[key] });
    if (res.ok && res.sharing && res.theySee) {
      setMentors((all) => all.map((x) => (x.id === m.id ? { ...x, sharing: res.sharing!, theySee: res.theySee! } : x)));
    } else {
      toast(
        res.error === "not_found" ? "That mentorship has ended - refresh to see it" : "Couldn't save that - nothing changed",
        "error",
      );
    }
    setSaving(null);
  }

  async function end(id: string, who: string) {
    setEnding(id);
    const res = await endMentorshipAction(id);
    if (res.ok || res.error === "not_found") {
      setMentors((all) => all.filter((x) => x.id !== id));
      setMentoring((all) => all.filter((x) => x.id !== id));
      toast(res.ok ? `Mentorship with ${who} ended` : "That mentorship had already ended", res.ok ? "success" : "error");
    } else {
      toast("Couldn't end it - try again", "error");
    }
    setEnding(null);
  }

  return (
    <div className="mt-4 flex flex-col gap-3" data-qa="mentorship">
      {mentors.map((m) => {
        const stats = teamStats(m.theySee, vocab);
        return (
          <section key={m.id} className="rounded-xl border border-subtle px-4 py-3" data-qa="my-mentor">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-wide text-muted">Your mentor</p>
                <p className="truncate text-sm font-medium text-offwhite">{m.mentor.name}</p>
              </div>
              <button
                type="button"
                disabled={ending !== null}
                onClick={() => void end(m.id, m.mentor.name)}
                className="min-h-[40px] shrink-0 px-2 text-xs text-muted transition-colors hover:text-offwhite disabled:opacity-50"
              >
                {ending === m.id ? "Ending…" : "End"}
              </button>
            </div>
            <p className="mt-1 text-xs text-muted">
              Separate from what the shop owner sees. Everything starts hidden.
            </p>
            <ul className="mt-1 divide-y divide-subtle">
              {SHARE_KEYS.map((key) => {
                const on = m.sharing[key];
                const label = stats.find((s) => s.key === key)!.label;
                const isSaving = saving === `${m.id}:${key}`;
                return (
                  <li key={key} className="flex items-center justify-between gap-4 py-2">
                    <p className="min-w-0 text-sm text-offwhite">{label}</p>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-label={`Share ${label} with ${m.mentor.name}`}
                      disabled={saving !== null}
                      onClick={() => void flip(m, key)}
                      data-qa={`mentor-share-${key}`}
                      className={cn(
                        "min-h-[40px] min-w-[72px] shrink-0 rounded-full px-4 text-xs font-medium transition-colors duration-150 ease-out disabled:opacity-60",
                        on && !isSaving
                          ? "bg-emerald-soft/15 text-emerald-soft"
                          : "border border-subtle text-muted hover:bg-charcoal-700",
                      )}
                    >
                      {isSaving ? "Saving…" : on ? "Shared" : "Hidden"}
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-[11px] uppercase tracking-wide text-muted">
              How you look to {m.mentor.name}
            </p>
            <MemberStatGrid stats={stats} qa="mentor-sees" />
          </section>
        );
      })}

      {mentoring.map((s) => (
        <section key={s.id} className="rounded-xl border border-subtle px-4 py-3" data-qa="my-student">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wide text-muted">You mentor</p>
              <p className="truncate text-sm font-medium text-offwhite">{s.student.name}</p>
            </div>
            <button
              type="button"
              disabled={ending !== null}
              onClick={() => void end(s.id, s.student.name)}
              className="min-h-[40px] shrink-0 px-2 text-xs text-muted transition-colors hover:text-offwhite disabled:opacity-50"
            >
              {ending === s.id ? "Ending…" : "End"}
            </button>
          </div>
          <MemberStatGrid stats={teamStats(s.numbers, vocab)} />
          <p className="mt-2 text-[11px] text-muted">
            Last 30 days. &ldquo;Hidden&rdquo; means they haven&apos;t shared it with you - only they can change that.
          </p>
        </section>
      ))}
    </div>
  );
}
