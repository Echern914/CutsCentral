"use client";

import { cap, useVocab } from "@/components/VocabProvider";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { fmtCents } from "./ExpensesCard";
import type { ByPersonData } from "./page";

/**
 * The totals above, split by who took the appointment.
 *
 * The API sends this only when there is more than one person to compare, so a
 * one-person shop never sees it. Every figure is the same rule as the tiles
 * above it, and the rows (with "Not assigned") add up to those tiles - the
 * Total line is there so an owner can check that at a glance.
 */
export function ByPersonCard({
  data,
  pending,
}: {
  data: ByPersonData;
  pending?: boolean;
}) {
  const vocab = useVocab();
  const visits = (n: number) => `${n} ${n === 1 ? vocab.serviceNoun : vocab.serviceNounPlural}`;
  const detail = (r: { visits: number; noShows: number; tipsCents?: number }) =>
    [
      visits(r.visits),
      r.noShows > 0 ? `${r.noShows} no-show${r.noShows === 1 ? "" : "s"}` : null,
      data.tips && r.tipsCents !== undefined ? `${fmtCents(r.tipsCents)} tips` : null,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <div data-testid="by-person">
    <Card className={cn("overflow-hidden transition-opacity duration-150 ease-out", pending && "opacity-60")}>
      <div className="border-b border-subtle px-5 py-4">
        <h2 className="font-display text-lg">By {vocab.providerNoun}</h2>
        <p className="mt-0.5 text-xs text-muted">
          The numbers above, split by who took each appointment.
          {data.tips ? " Tips are counted separately and are not part of revenue." : ""}
        </p>
      </div>
      <ul className="divide-y divide-[rgba(245,245,244,0.08)]">
        {data.rows.map((r) => (
          <li key={r.staffId} className="flex items-center justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-offwhite">{r.name}</p>
              <p className="mt-0.5 text-xs text-muted">
                {detail(r)}
                {!r.active && " · no longer on your booking page"}
              </p>
            </div>
            <p className="shrink-0 font-display text-lg tabular-nums text-offwhite">{fmtCents(r.revenueCents)}</p>
          </li>
        ))}
        {data.notAssigned && (
          <li className="flex items-center justify-between gap-3 px-5 py-3" data-testid="not-assigned">
            <div className="min-w-0">
              <p className="text-sm font-medium text-offwhite">Not assigned</p>
              <p className="mt-0.5 text-xs text-muted">
                {detail(data.notAssigned)} · synced from another booking app, which doesn&apos;t record who
                did it
              </p>
            </div>
            <p className="shrink-0 font-display text-lg tabular-nums text-offwhite">
              {fmtCents(data.notAssigned.revenueCents)}
            </p>
          </li>
        )}
        <li className="flex items-center justify-between gap-3 bg-offwhite/[0.03] px-5 py-3" data-testid="by-person-total">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-offwhite">Total</p>
            <p className="mt-0.5 text-xs text-muted">{detail(data.total)}</p>
          </div>
          <p className="shrink-0 font-display text-lg tabular-nums text-gold">{fmtCents(data.total.revenueCents)}</p>
        </li>
      </ul>
      <p className="px-5 pb-4 pt-3 text-[11px] text-muted">
        Each {vocab.providerNoun} with a staff login sees their own line on their home screen, and no one
        else&apos;s. {cap(vocab.serviceNounPlural)} include no-shows, as the tile above does.
      </p>
    </Card>
    </div>
  );
}
