"use client";

import { useMemo, useState, useTransition } from "react";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/Card";
import { fadeUp, staggerContainer } from "@/components/motion/variants";
import { cn } from "@/lib/cn";
import type { AgendaResponse, AgendaRow } from "./page";
import {
  cancelAppointmentAction,
  completeAppointmentAction,
  noShowAppointmentAction,
} from "./actions";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * The barber's day-to-day calendar. Loads a wide window once (from the server)
 * and buckets appointments by day IN THE SHOP'S TIMEZONE, so a "day" always
 * means the barber's local day, not the viewer's. A week strip + prev/next lets
 * them scan day to day. Native ("appointment") rows can be marked done / no-show
 * / canceled in place; synced ("visit") rows (Acuity / Square) are read-only,
 * since those platforms own the source of truth.
 */
export function BookingCalendar({
  initial,
  toast,
}: {
  initial: AgendaResponse;
  toast: Toast;
}) {
  const tz = initial.timezone;

  // Shop-tz YYYY-MM-DD bucket key for an instant. en-CA yields YYYY-MM-DD.
  const dayKeyFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
    [tz],
  );
  const dayLabelFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "long",
        month: "short",
        day: "numeric",
      }),
    [tz],
  );
  const chipFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
        day: "numeric",
      }),
    [tz],
  );
  const timeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "numeric",
        minute: "2-digit",
      }),
    [tz],
  );

  const dayKey = (iso: string) => dayKeyFmt.format(new Date(iso));

  // Bucket the flat agenda into day -> rows (sorted by start within each day).
  const byDay = useMemo(() => {
    const map = new Map<string, AgendaRow[]>();
    for (const row of initial.agenda) {
      const key = dayKey(row.start);
      const list = map.get(key) ?? [];
      list.push(row);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.start.localeCompare(b.start));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.agenda, tz]);

  // Today in the SHOP's tz (not the viewer's) as the default selected day.
  const todayKey = dayKeyFmt.format(new Date());
  const [selectedDay, setSelectedDay] = useState<string>(todayKey);

  // The strip of days to show: the union of every day that has appointments plus
  // today, sorted. Keeps navigation to days that actually matter, but always
  // lets the barber land on today even with nothing booked.
  const stripDays = useMemo(() => {
    const set = new Set<string>(byDay.keys());
    set.add(todayKey);
    set.add(selectedDay);
    return [...set].sort();
  }, [byDay, todayKey, selectedDay]);

  const selectedIdx = stripDays.indexOf(selectedDay);
  const gotoOffset = (delta: number) => {
    const next = stripDays[selectedIdx + delta];
    if (next) setSelectedDay(next);
  };

  const rows = byDay.get(selectedDay) ?? [];
  const activeCount = rows.filter((r) => r.status !== "canceled").length;

  // A real instant on the selected day (for the header label in shop tz). Falls
  // back to `today` only when the day is empty. NEVER build a Date from the
  // YYYY-MM-DD key directly - that parses in the viewer's zone, not the shop's.
  const headerLabel = rows[0]
    ? dayLabelFmt.format(new Date(rows[0].start))
    : selectedDay === todayKey
      ? dayLabelFmt.format(new Date())
      : selectedDay;

  return (
    <Card className="p-5">
      {/* Week strip: prev / day chips / next */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => gotoOffset(-1)}
          disabled={selectedIdx <= 0}
          aria-label="Previous day"
          className="shrink-0 rounded-lg border border-subtle px-2.5 py-2 text-sm text-muted transition-colors hover:text-offwhite disabled:opacity-30"
        >
          ‹
        </button>
        <div className="flex flex-1 gap-2 overflow-x-auto pb-1">
          {stripDays.map((d) => {
            const count = (byDay.get(d) ?? []).filter(
              (r) => r.status !== "canceled",
            ).length;
            // Label from a real instant on that day when available; today when
            // it's today; else the plain key (rare - a selected empty future day).
            const sample = (byDay.get(d) ?? [])[0]?.start;
            const label = sample
              ? chipFmt.format(new Date(sample))
              : d === todayKey
                ? chipFmt.format(new Date())
                : d;
            return (
              <button
                key={d}
                type="button"
                onClick={() => setSelectedDay(d)}
                className={cn(
                  "shrink-0 rounded-lg border px-3 py-2 text-center text-xs transition-colors",
                  d === selectedDay
                    ? "border-gold/40 bg-gold/15 text-gold"
                    : "border-subtle text-muted hover:text-offwhite",
                )}
              >
                <span className="block whitespace-nowrap">{label}</span>
                {count > 0 && (
                  <span className="mt-0.5 block text-[10px] opacity-70">
                    {count} {count === 1 ? "cut" : "cuts"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => gotoOffset(1)}
          disabled={selectedIdx >= stripDays.length - 1}
          aria-label="Next day"
          className="shrink-0 rounded-lg border border-subtle px-2.5 py-2 text-sm text-muted transition-colors hover:text-offwhite disabled:opacity-30"
        >
          ›
        </button>
      </div>

      {/* Selected-day header */}
      <div className="mt-4 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg">{headerLabel}</h2>
        <span className="text-xs text-muted">
          {activeCount} {activeCount === 1 ? "appointment" : "appointments"}
        </span>
      </div>

      {/* Rows */}
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No appointments on this day.</p>
      ) : (
        <motion.ul
          key={selectedDay}
          variants={staggerContainer}
          initial="hidden"
          animate="show"
          className="mt-3 flex flex-col gap-2"
        >
          {rows.map((r) => (
            <AgendaRowItem key={r.id} row={r} timeLabel={timeFmt.format(new Date(r.start))} toast={toast} />
          ))}
        </motion.ul>
      )}

      {initial.agenda.length >= 500 && (
        <p className="mt-4 text-[11px] text-muted">
          Showing the first 500 appointments in this range.
        </p>
      )}
    </Card>
  );
}

const STATUS_PILL: Record<AgendaRow["status"], { label: string; cls: string }> = {
  upcoming: { label: "Upcoming", cls: "bg-gold/15 text-gold" },
  completed: { label: "Done", cls: "bg-emerald-soft/15 text-emerald-soft" },
  canceled: { label: "Canceled", cls: "bg-charcoal-700 text-muted" },
  no_show: { label: "No-show", cls: "bg-danger-soft/15 text-danger-soft" },
};

function AgendaRowItem({
  row,
  timeLabel,
  toast,
}: {
  row: AgendaRow;
  timeLabel: string;
  toast: Toast;
}) {
  const [pending, start] = useTransition();
  const pill = STATUS_PILL[row.status];
  // Actions only for NATIVE upcoming rows: synced (Acuity/Square) visits are
  // owned by that platform, and the mutation endpoints only touch Appointments.
  const canAct = row.source === "appointment" && row.status === "upcoming";

  function act(
    fn: (id: string) => Promise<{ ok: boolean }>,
    label: string,
  ) {
    start(async () => {
      const res = await fn(row.id);
      toast(res.ok ? label : "Couldn't update", res.ok ? "success" : "error");
    });
  }

  return (
    <motion.li
      variants={fadeUp}
      className={cn(
        "rounded-xl border border-subtle px-4 py-3",
        row.status === "canceled" && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium">
            <span className="tabular-nums text-muted">{timeLabel}</span>
            <span className="truncate">{row.clientName || "Client"}</span>
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {row.serviceName ?? "Appointment"}
            {row.price != null && ` · $${row.price.toFixed(0)}`}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium",
            pill.cls,
          )}
        >
          {pill.label}
        </span>
      </div>

      {canAct && (
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => act(completeAppointmentAction, "Marked done")}
            disabled={pending}
            className="rounded-lg border border-emerald-soft/40 px-3 py-1 text-xs text-emerald-soft disabled:opacity-50"
          >
            Mark done
          </button>
          <button
            onClick={() => act(noShowAppointmentAction, "Marked no-show")}
            disabled={pending}
            className="rounded-lg border border-subtle px-3 py-1 text-xs text-muted disabled:opacity-50"
          >
            No-show
          </button>
          <button
            onClick={() => act(cancelAppointmentAction, "Canceled")}
            disabled={pending}
            className="rounded-lg border border-danger-soft/40 px-3 py-1 text-xs text-danger-soft disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}
    </motion.li>
  );
}
