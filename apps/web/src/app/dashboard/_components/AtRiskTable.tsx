"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { nudgeNowAction } from "../actions";

export interface AtRiskRow {
  id: string;
  name: string;
  daysOverdue: number;
  medianIntervalDays: number;
  lastVisitAt: string;
}

export function AtRiskTable({ rows }: { rows: AtRiskRow[] }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-subtle px-5 py-4">
        <h2 className="font-display text-lg">At risk</h2>
        <p className="text-xs text-muted">
          Overdue for a cut with no upcoming booking.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">
          No clients at risk right now.
        </p>
      ) : (
        <ul className="divide-y divide-subtle">
          {rows.map((r) => (
            <NudgeRow key={r.id} row={r} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function NudgeRow({ row }: { row: AtRiskRow }) {
  const [pending, startTransition] = useTransition();
  const [sent, setSent] = useState(false);

  return (
    <li className="flex items-center justify-between px-5 py-4">
      <div>
        <p className="text-sm font-medium text-offwhite">{row.name}</p>
        <p className="text-xs text-muted">
          {row.daysOverdue}d overdue · every ~{row.medianIntervalDays}d
        </p>
      </div>
      <button
        disabled={pending || sent}
        onClick={() =>
          startTransition(async () => {
            const res = await nudgeNowAction(row.id);
            if (res.ok) setSent(true);
          })
        }
        className="rounded-full border border-gold/50 px-4 py-1.5 text-xs font-medium text-gold hover:bg-gold/10 disabled:opacity-50"
      >
        {sent ? "Sent" : pending ? "Sending…" : "Nudge now"}
      </button>
    </li>
  );
}
