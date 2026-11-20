"use client";

import { useEffect, useState } from "react";
import { cap, useVocab } from "@/components/VocabProvider";
import { Card } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { cn } from "@/lib/cn";
import { getMyNumbersAction, type MyNumbersData, type MyNumbersPeriod } from "./barberReportActions";

const PERIODS: readonly { key: MyNumbersPeriod; label: string }[] = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "365d", label: "12 months" },
];

/** "$1,240" or "$12.50": whole dollars when there are no cents. */
function money(cents: number): string {
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}

/**
 * "My numbers" on a team member's home screen: their own appointments,
 * revenue and tips for a period - the same figures the owner sees beside their
 * name on Insights, and nothing about anyone else or the shop as a whole.
 *
 * Self-loading. Renders nothing for a login with no chair linked (the home
 * screen already says how to fix that) or when the read fails, so the rest of
 * the screen is never held up by it.
 */
export function MyNumbers() {
  const vocab = useVocab();
  const [period, setPeriod] = useState<MyNumbersPeriod>("30d");
  const [data, setData] = useState<MyNumbersData | null>(null);
  const [pending, setPending] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPending(true);
    void getMyNumbersAction(period)
      .catch(() => ({ ok: false as const }))
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setData(res.data);
          setFailed(false);
        } else {
          setFailed(true);
        }
        setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  // Nothing linked, or never loaded: say nothing here.
  if (!data || !data.chair) return null;

  const visits = data.visits ?? 0;
  const tips = data.tipsCents ?? null;
  return (
    <div className="mt-6" data-testid="my-numbers">
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-subtle px-5 py-4">
        <h2 className="font-display text-lg">My numbers</h2>
        <Segmented options={PERIODS} value={period} onChange={setPeriod} ariaLabel="Period" />
      </div>
      <div
        className={cn(
          "grid gap-2.5 px-5 py-4 transition-opacity duration-150 ease-out",
          tips === null ? "grid-cols-2" : "grid-cols-3",
          pending && "opacity-60",
        )}
      >
        <Figure label={cap(vocab.serviceNounPlural)} value={String(visits)} />
        <Figure label="Revenue" value={money(data.revenueCents ?? 0)} />
        {tips !== null && <Figure label="Tips" value={money(tips)} />}
      </div>
      <p className="px-5 pb-4 text-[11px] text-muted">
        {failed
          ? "Couldn't load that period. Still showing the last one."
          : `${data.periodLabel ?? ""}. Your own appointments only${
              (data.noShows ?? 0) > 0
                ? `, including ${data.noShows} no-show${data.noShows === 1 ? "" : "s"}, which earn nothing`
                : ""
            }. Tips are not part of revenue.`}
      </p>
    </Card>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-subtle bg-charcoal-800 px-3 py-3 text-center">
      <p className="font-display text-xl tabular-nums text-gold [overflow-wrap:anywhere]">{value}</p>
      <p className="mt-0.5 text-[11px] text-muted">{label}</p>
    </div>
  );
}
