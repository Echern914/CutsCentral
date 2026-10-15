"use client";

import { useEffect, useRef, useState } from "react";
import type { BusinessVocabulary } from "@chairback/config";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { ScheduleKey, ScheduleRow } from "@/components/team/ScheduleRow";
import { barRange, dayChipLabel, type TeamScheduleData } from "@/lib/teamSchedule";
import { teamScheduleAction } from "./actions";

/**
 * The owner's view of when the team works: pick a day, see each member who
 * shares their schedule - where they are now, their hours, what's booked and
 * what's free. Members who don't share are listed as hidden; only they can
 * change that. Times only: the API never sends who is booked or for what.
 */
export function TeamSchedule({
  initial,
  vocab,
  version = 0,
}: {
  initial: TeamScheduleData;
  vocab: BusinessVocabulary;
  /** Bumped by the card after the team changes (approve, remove): re-read the day shown. */
  version?: number;
}) {
  const { toast } = useToast();
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(false);

  // The team changed: someone joined or left. Quietly re-read the same day; a
  // failure keeps what's on screen (the next change or a refresh catches up).
  const seen = useRef(version);
  useEffect(() => {
    if (seen.current === version) return;
    seen.current = version;
    let live = true;
    void teamScheduleAction(data.day)
      .catch(() => null)
      .then((fresh) => {
        if (live && fresh) setData(fresh);
      });
    return () => {
      live = false;
    };
    // Only the version starts a re-read; the day is read from the latest render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  async function pickDay(day: string) {
    if (day === data.day || loading) return;
    setLoading(true);
    const fresh = await teamScheduleAction(day).catch(() => null);
    if (fresh) setData(fresh);
    else toast("Couldn't load that day - try again", "error");
    setLoading(false);
  }

  const shown = data.members.filter((m) => m.shared && m.chairs);
  const range = barRange(shown.flatMap((m) => m.chairs!));
  const hidden = data.members.filter((m) => !m.shared);

  return (
    <section aria-labelledby="team-schedule" data-qa="team-schedule">
      <h3 id="team-schedule" className="text-sm font-medium text-offwhite">
        Schedules
      </h3>
      <p className="mt-0.5 text-xs text-muted">
        When each {vocab.providerNoun} works, is booked and is free - only for
        those who share it. Never who is booked.
      </p>

      <div role="group" aria-label="Which day" className="mt-2 flex flex-wrap gap-1.5" data-qa="schedule-days">
        {data.days.map((key, i) => (
          <button
            key={key}
            type="button"
            aria-pressed={data.day === key}
            disabled={loading}
            onClick={() => void pickDay(key)}
            className={cn(
              "min-h-[40px] rounded-full border px-3 text-xs font-medium transition-colors disabled:opacity-60",
              data.day === key
                ? "border-gold/50 bg-gold/10 text-gold"
                : "border-subtle text-muted hover:text-offwhite",
            )}
          >
            {dayChipLabel(key, i)}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          No one shares their schedule yet. Each {vocab.providerNoun} turns it on
          from their own Teams page.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3" aria-busy={loading}>
          {shown.map((m) =>
            m.chairs!.length === 0 ? (
              <li key={m.linkId} className="rounded-xl border border-subtle px-4 py-3" data-qa="schedule-member">
                <p className="text-sm font-medium text-offwhite">{m.business.name}</p>
                <p className="text-xs text-muted">No hours set up yet.</p>
              </li>
            ) : (
              <li key={m.linkId} className="flex flex-col gap-3 rounded-xl border border-subtle px-4 py-3" data-qa="schedule-member">
                {m.chairs!.map((chair, i) => (
                  <ScheduleRow
                    key={`${chair.name}:${i}`}
                    chair={chair}
                    timezone={data.timezone}
                    range={range}
                    label={m.chairs!.length === 1 ? m.business.name : `${m.business.name} · ${chair.name}`}
                  />
                ))}
              </li>
            ),
          )}
        </ul>
      )}
      {shown.length > 0 && range && (
        <div className="mt-2">
          <ScheduleKey />
        </div>
      )}

      {hidden.length > 0 && (
        <p className="mt-2 text-xs text-muted [overflow-wrap:anywhere]" data-qa="schedule-hidden">
          Not shared: {hidden.map((m) => m.business.name).join(", ")}.
        </p>
      )}
    </section>
  );
}
