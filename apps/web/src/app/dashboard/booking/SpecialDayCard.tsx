"use client";

import { useMemo, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { useVocab } from "@/components/VocabProvider";
import { zonedDateKey } from "@chairback/config/time";
import { removeSpecialDaysAction, type SpecialDayRow } from "./actions";
import type { StaffRow } from "./page";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * SPECIAL DAYS - the list of dates run their own way (Drick: "if I want to
 * completely modify how my Thanksgiving day looks instead of working a regular
 * schedule, let's say I want to make all cuts (20 min long) only on that day
 * and charge $65 all day, I need that option").
 *
 * The day itself is built and changed in the LIVE VIEW (LiveDayView.tsx) -
 * the same one Holiday pricing opens - so there is one tool for "this date is
 * different", whichever card the barber starts from. This card lists what is
 * planned, opens a day, and removes one.
 */

/** "2026-11-26" -> "Thu, Nov 26". Noon avoids a DST off-by-one. */
function prettyDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function SpecialDayCard({
  rows,
  loadFailed,
  onReload,
  staff,
  timezone,
  toast,
  onOpen,
  onChanged,
}: {
  /** Upcoming special days, one row per chair. null = still loading. */
  rows: SpecialDayRow[] | null;
  loadFailed: boolean;
  onReload: () => void;
  staff: StaffRow[];
  timezone: string;
  toast: Toast;
  /** Open the live view on a date. */
  onOpen: (date: string, name?: string) => void;
  /** A special day was removed (lists re-read). */
  onChanged?: () => void;
}) {
  const vocab = useVocab();
  const today = zonedDateKey(new Date(), timezone);
  const time = useMemo(
    () => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: timezone }),
    [timezone],
  );
  const staffName = (id: string) => staff.find((s) => s.id === id)?.name ?? "?";
  const [planning, setPlanning] = useState(false);
  const [date, setDate] = useState("");
  const [pending, setPending] = useState(false);

  /** Every chair's special day on one date goes together. */
  async function remove(group: SpecialDayRow[]) {
    const first = group[0]!;
    const label = first.name ?? prettyDate(first.date);
    const booked = group.reduce((n, r) => n + r.booked, 0);
    const question =
      `Remove ${label} on ${prettyDate(first.date)}? Its open times are deleted and the normal schedule comes back.` +
      (booked > 0 ? ` ${booked} booked visit${booked === 1 ? "" : "s"} stay booked.` : "");
    if (pending || !window.confirm(question)) return;
    setPending(true);
    try {
      const r = await removeSpecialDaysAction(group.map((g) => g.ruleId));
      if (r.ok) {
        toast(
          `${label} removed` +
            (r.bookedKept > 0 ? ` - ${r.bookedKept} booked visit${r.bookedKept === 1 ? "" : "s"} kept` : ""),
          "success",
        );
        onChanged?.();
      } else toast("Couldn't remove it - nothing was changed", "error");
    } finally {
      setPending(false);
    }
  }

  // One row per date (and name), chairs listed underneath.
  const groups = useMemo(() => {
    const by = new Map<string, SpecialDayRow[]>();
    for (const r of rows ?? []) {
      const key = `${r.date}|${r.name ?? ""}`;
      by.set(key, [...(by.get(key) ?? []), r]);
    }
    return [...by.values()];
  }, [rows]);

  return (
    <Card className="p-5">
      <CardHeader
        title="Special day"
        subtitle={`Run one date your own way: your hours, your lengths, a price on every opening. Only those openings can be booked that day - the normal schedule is closed for the ${vocab.providerNounPlural} who have them.`}
      />

      {rows === null && !loadFailed ? (
        <p className="mt-3 text-sm text-muted">Loading…</p>
      ) : loadFailed ? (
        <p className="mt-3 text-sm text-muted">
          Couldn&apos;t load your special days.{" "}
          <button type="button" onClick={onReload} className="text-gold underline">
            Try again
          </button>
        </p>
      ) : groups.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          None planned. Thanksgiving with 20-minute openings at $65 from 9 to 5, a
          late-opening Saturday - open the day, fill it, tap any opening to change
          its price, and save when it looks right.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-subtle overflow-hidden rounded-xl border border-subtle">
          {groups.map((group) => {
            const first = group[0]!;
            return (
              <li
                key={`${first.date}-${first.ruleId}`}
                className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-offwhite">
                    {first.name ?? "Special day"}
                    <span className="ml-2 text-xs font-normal text-muted">{prettyDate(first.date)}</span>
                  </p>
                  {group.map((r) => (
                    <p key={r.ruleId} className="text-xs text-muted">
                      {staffName(r.staffId)}:{" "}
                      {r.firstStart && r.lastEnd
                        ? `${time.format(new Date(r.firstStart))}–${time.format(new Date(r.lastEnd))}, `
                        : ""}
                      {r.openings} opening{r.openings === 1 ? "" : "s"} ·{" "}
                      {r.minPrice !== undefined && r.maxPrice !== undefined && r.minPrice !== r.maxPrice
                        ? `$${r.minPrice.toFixed(0)}–$${r.maxPrice.toFixed(0)}`
                        : `$${r.price.toFixed(0)}`}
                      {r.booked > 0 ? ` · ${r.booked} booked` : ""}
                    </p>
                  ))}
                </div>
                <span className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => onOpen(first.date, first.name ?? undefined)}
                    className="min-h-[44px] rounded px-2 text-xs font-medium text-gold hover:underline"
                    aria-label={`Open live view of ${first.name ?? "special day"} on ${prettyDate(first.date)}`}
                  >
                    Open live view
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(group)}
                    disabled={pending}
                    className="min-h-[44px] rounded px-2 text-xs text-muted transition-colors hover:text-danger-soft disabled:opacity-50"
                    aria-label={`Remove special day on ${prettyDate(first.date)}`}
                  >
                    Remove
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {!planning ? (
        <button
          type="button"
          onClick={() => {
            setDate("");
            setPlanning(true);
          }}
          disabled={staff.filter((s) => s.active).length === 0}
          className="mt-4 min-h-[44px] rounded-lg bg-gold/15 px-3 text-xs font-medium text-gold transition-colors hover:bg-gold/25 disabled:opacity-50"
        >
          + Plan a special day
        </button>
      ) : (
        <div className="mt-4 flex flex-wrap items-end gap-2 rounded-xl border border-gold/40 bg-gold/5 p-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Date
            <input
              type="date"
              min={today}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-11 rounded-xl border border-subtle bg-charcoal-700 px-3 text-sm text-offwhite"
            />
          </label>
          <button
            type="button"
            disabled={!date || date < today}
            onClick={() => {
              setPlanning(false);
              onOpen(date);
            }}
            className="h-11 rounded-xl bg-gold/20 px-4 text-sm font-semibold text-gold transition-colors hover:bg-gold/30 disabled:opacity-50"
          >
            Open live view
          </button>
          <button
            type="button"
            onClick={() => setPlanning(false)}
            className="h-11 rounded-xl px-3 text-sm text-muted transition-colors hover:text-offwhite"
          >
            Cancel
          </button>
        </div>
      )}
    </Card>
  );
}
