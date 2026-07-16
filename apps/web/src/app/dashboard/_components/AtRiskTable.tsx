"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { nudgeNowAction } from "../actions";

export interface AtRiskRow {
  id: string;
  name: string;
  phone: string | null;
  lastService: string | null;
  magicToken: string;
  daysOverdue: number;
  medianIntervalDays: number;
  lastVisitAt: string;
}

export function AtRiskTable({
  rows,
  appBaseUrl,
}: {
  rows: AtRiskRow[];
  appBaseUrl: string;
}) {
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
            <NudgeRow key={r.id} row={r} appBaseUrl={appBaseUrl} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function NudgeRow({ row, appBaseUrl }: { row: AtRiskRow; appBaseUrl: string }) {
  const [pending, startTransition] = useTransition();
  const [sent, setSent] = useState(false);
  const [copied, setCopied] = useState(false);

  const rewardsUrl = `${appBaseUrl}/r/${row.magicToken}`;

  function copyLink() {
    void navigator.clipboard?.writeText(rewardsUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <li className="flex items-center justify-between gap-3 px-5 py-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-offwhite">{row.name}</p>
        <p className="truncate text-xs text-muted">
          {row.daysOverdue}d overdue · every ~{row.medianIntervalDays}d
          {row.lastService ? ` · last: ${row.lastService}` : ""}
        </p>
        {row.phone && <p className="text-xs text-muted">{row.phone}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={copyLink}
          className="rounded-full border border-subtle px-3 py-1.5 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700"
          title="Copy this client's rewards link"
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        <button
          disabled={pending || sent}
          onClick={() =>
            startTransition(async () => {
              const res = await nudgeNowAction(row.id);
              if (res.ok) setSent(true);
            })
          }
          className="rounded-full border border-gold/50 px-4 py-1.5 text-xs font-medium text-gold transition-colors duration-150 ease-out hover:bg-gold/10 disabled:opacity-50"
        >
          {sent ? "Sent" : pending ? "Sending…" : "Nudge now"}
        </button>
      </div>
    </li>
  );
}
