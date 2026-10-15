"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BusinessVocabulary } from "@chairback/config";
import { cap } from "@/components/VocabProvider";
import { cn } from "@/lib/cn";
import { deskReasonLine, deskStatusLine, type TeamDeskData } from "@/lib/teamWalkIns";
import { teamWalkInsAction } from "./actions";

/** The line moves; read it again this often while the page is in view. */
const POLL_MS = 30_000;

/**
 * The shop's FRONT DESK for a team of independent businesses: customers check
 * in on the shop's tablet, pick who they're here for, and join that barber's
 * own line. Here the owner sees whether the desk is running, who takes its
 * walk-ins, and its line - first names, who for, the wait. Read-only: each
 * business calls its people up from its own Walk-ins board.
 */
export function TeamWalkIns({
  initial,
  vocab,
  version = 0,
}: {
  initial: TeamDeskData;
  vocab: BusinessVocabulary;
  /** Bumped by the card after the team changes (approve, remove): re-read. */
  version?: number;
}) {
  const [data, setData] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const fresh = await teamWalkInsAction().catch(() => null);
    if (fresh) setData(fresh);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Someone joined or left the team: who takes walk-ins may have changed.
  const seen = useRef(version);
  useEffect(() => {
    if (seen.current === version) return;
    seen.current = version;
    void refresh();
  }, [version, refresh]);

  if (!data.available || !data.desk) return null;
  const members = data.members ?? [];
  const line = data.line ?? [];
  const taking = members.filter((m) => m.taking && m.reason === null);
  const setUp = data.desk.on && data.desk.hasKiosk;

  return (
    <section aria-labelledby="team-walk-ins" data-qa="team-walk-ins">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="team-walk-ins" className="text-sm font-medium text-offwhite">
          Front desk walk-ins
        </h3>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="min-h-[40px] shrink-0 px-2 text-xs text-muted transition-colors hover:text-offwhite disabled:opacity-50"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p className="mt-0.5 text-xs text-muted">
        {cap(vocab.clientNounPlural)} check in on your
        shop&apos;s tablet, pick who they&apos;re here for, and join that {vocab.providerNoun}&apos;s own
        line.
      </p>

      {!setUp && (
        <div className="mt-2 rounded-xl border border-subtle px-4 py-3" data-qa="desk-setup">
          <p className="text-sm text-offwhite">
            {data.desk.on ? "Get the tablet link to start." : "Your walk-ins are off."}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            Turn on Walk-ins and get the check-in link for your tablet in Booking settings.
          </p>
          <Link
            href="/dashboard/booking?tab=Settings"
            className="mt-2 inline-flex min-h-[40px] items-center rounded-full border border-subtle px-4 text-xs text-muted transition-colors hover:bg-charcoal-700 hover:text-offwhite"
          >
            Open Booking settings
          </Link>
        </div>
      )}
      {setUp && !data.desk.acceptingNow && (
        <p className="mt-2 text-xs text-gold">Paused - the tablet isn&apos;t taking check-ins.</p>
      )}

      <ul className="mt-2 flex flex-col gap-1" data-qa="desk-members">
        {members.map((m) => (
          <li key={m.linkId} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-sm text-offwhite">{m.business.name}</span>
            <span
              className={cn(
                "shrink-0 text-xs",
                m.taking && m.reason === null ? "text-emerald-soft" : "text-muted",
              )}
            >
              {deskReasonLine(m.taking ? m.reason : "not_taking")}
            </span>
          </li>
        ))}
      </ul>
      {taking.length === 0 && members.length > 0 && (
        <p className="mt-1 text-xs text-muted">
          Each {vocab.providerNoun} turns it on from their own Teams page.
        </p>
      )}

      <div className="mt-3">
        <p className="text-[11px] uppercase tracking-wide text-muted">In line now</p>
        {line.length === 0 ? (
          <p className="mt-1 text-sm text-muted">No one waiting.</p>
        ) : (
          <ul className="mt-1 divide-y divide-subtle rounded-xl border border-subtle" data-qa="desk-line">
            {line.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-2.5">
                <p className="min-w-0 text-sm text-offwhite [overflow-wrap:anywhere]">
                  {e.firstName} <span className="text-muted">· {e.business.name}</span>
                </p>
                <p className="shrink-0 text-xs tabular-nums text-muted">{deskStatusLine(e.status, e.waitMin)}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
