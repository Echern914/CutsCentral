"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { Segmented } from "@/components/ui/Segmented";
import {
  creditPastVisitsAction,
  previewPastVisitsAction,
  type PastVisitsCount,
  type PastVisitsMonths,
} from "./actions";

const PERIODS = [
  { key: "3", label: "3 months" },
  { key: "6", label: "6 months" },
  { key: "12", label: "12 months" },
] as const;
type Period = (typeof PERIODS)[number]["key"];

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/**
 * Past visits. A visit that ended before rewards were turned on doesn't earn
 * punches by itself. The owner picks how far back, checks what that would
 * give, and only "Credit them" writes it. Customers aren't sent anything.
 */
export function PastVisits() {
  const [period, setPeriod] = useState<Period>("3");
  // A check is kept with the period it was for, and shown - and confirmable -
  // only while that period is still picked: a slow answer for 3 months must
  // never sit beside "12 months" and let 12 be credited under 3's numbers.
  const [checked, setChecked] = useState<{ months: PastVisitsMonths; count: PastVisitsCount } | null>(null);
  const [done, setDone] = useState<PastVisitsCount | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Plain async rather than useTransition, like TierPerks: an async callback
  // to startTransition is the repo's inherited @types/react error.
  const [pending, setPending] = useState(false);
  const months = Number(period) as PastVisitsMonths;
  const preview = checked?.months === months ? checked.count : null;

  function pick(next: Period) {
    setPeriod(next);
    setChecked(null);
    setDone(null);
    setError(null);
  }

  async function check() {
    const asked = months;
    setDone(null);
    setError(null);
    setPending(true);
    try {
      const r = await previewPastVisitsAction(asked);
      if (r.ok) setChecked({ months: asked, count: r.data });
      else setError("Couldn't check your past visits. Try again.");
    } finally {
      setPending(false);
    }
  }

  async function credit() {
    if (!checked) return;
    setError(null);
    setPending(true);
    try {
      const r = await creditPastVisitsAction(checked.months);
      if (r.ok) {
        setDone(r.data);
        setChecked(null);
      } else {
        setError("Couldn't finish. Try again - a visit is never credited twice.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="mb-6 p-5">
      <h2 className="text-base font-semibold text-offwhite">Past visits</h2>
      <p className="mt-1 text-sm text-muted">
        Visits from before you turned rewards on don&apos;t earn punches by themselves. You can
        credit them here. Customers don&apos;t get a message about it.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Segmented
          options={PERIODS}
          value={period}
          onChange={pick}
          ariaLabel="How far back"
          size="comfortable"
        />
        <Button variant="ghost" onClick={() => void check()} disabled={pending}>
          Check
        </Button>
      </div>

      <div aria-live="polite" className="mt-4 text-sm">
        {preview && preview.visits > 0 && (
          <div>
            <p className="font-medium text-offwhite">
              Credit {count(preview.visits, "past visit", "past visits")}:{" "}
              {count(preview.punches, "punch", "punches")} to{" "}
              {count(preview.customers, "customer", "customers")}.
            </p>
            <p className="mt-1 text-xs text-muted">
              Visits from {day(preview.from)} to {day(preview.startedAt)}, before rewards started.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => void credit()} disabled={pending}>
                Credit them
              </Button>
              <Button variant="ghost" onClick={() => setChecked(null)} disabled={pending}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {preview && preview.visits === 0 && (
          <p className="text-muted">No past visits to credit from that time.</p>
        )}
        {done && (
          <p className="text-offwhite">
            {done.visits > 0
              ? `Done. ${count(done.customers, "customer", "customers")} got ${count(done.punches, "punch", "punches")}.`
              : "Nothing left to credit - those visits already have their punches."}
          </p>
        )}
        <FormError>{error}</FormError>
      </div>
    </Card>
  );
}
