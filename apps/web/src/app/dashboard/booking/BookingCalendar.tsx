"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card } from "@/components/ui/Card";
import { fadeUp, staggerContainer } from "@/components/motion/variants";
import { cn } from "@/lib/cn";
import type { AgendaResponse, AgendaRow, WaitlistRow } from "./page";
import {
  cancelAppointmentAction,
  completeAppointmentAction,
  getAgendaAction,
  noShowAppointmentAction,
  setWaitlistStatusAction,
} from "./actions";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * The barber's schedule as a MONTH CALENDAR. Each day is a cell; tapping a day
 * drops down an hour-by-hour planner of that day's appointments (every working
 * hour shown, empty hours as open gaps), with the haircut type on each booking.
 *
 * Data: the current month is loaded server-side on first paint; paging to
 * another month refetches via getAgendaAction. Everything is bucketed and
 * formatted in the SHOP's timezone (a "day"/"hour" = the barber's local one).
 * Native ("appointment") rows can be marked done / no-show / canceled here;
 * synced ("visit") rows (Acuity/Square) are read-only.
 */

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
// Default planner window (barber's local hours). Runs to midnight because some
// barbers cut late into the night; the window auto-widens earlier/later to fit
// any booking outside it (e.g. a 6am or 1am appointment).
const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 23; // 11 PM row shown; midnight+ bookings widen it further

export function BookingCalendar({
  initial,
  initialWaitlist,
  toast,
}: {
  initial: AgendaResponse;
  initialWaitlist: WaitlistRow[];
  toast: Toast;
}) {
  const tz = initial.timezone;

  // ---- Shop-tz formatters (a day/hour always means the barber's local one) ----
  const partsFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        hour12: false,
      }),
    [tz],
  );
  const monthTitleFmt = useMemo(
    () => new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long", year: "numeric" }),
    [tz],
  );
  const dayTitleFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "long",
        month: "short",
        day: "numeric",
      }),
    [tz],
  );
  const timeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }),
    [tz],
  );

  /** {year, month(1-12), day(1-31), hour(0-23)} of an ISO instant, in shop tz. */
  const shopParts = (iso: string) => {
    const p = partsFmt.formatToParts(new Date(iso));
    const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
    return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") };
  };
  const dayKeyOf = (iso: string) => {
    const { y, m, d } = shopParts(iso);
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  // "Today" in shop tz (as a YYYY-MM-DD key + the y/m for the initial month).
  const todayParts = shopParts(new Date().toISOString());
  const todayKey = `${todayParts.y}-${String(todayParts.m).padStart(2, "0")}-${String(
    todayParts.d,
  ).padStart(2, "0")}`;

  // ---- Loaded agenda (starts server-provided, replaced when paging months) ----
  const [agenda, setAgenda] = useState<AgendaRow[]>(initial.agenda);
  const [pendingMonth, startMonthLoad] = useTransition();
  // Which months we've already fetched, so re-visiting one doesn't refetch.
  const [loadedMonths, setLoadedMonths] = useState<Set<string>>(
    () => new Set([`${todayParts.y}-${todayParts.m}`]),
  );

  // Bucket every loaded row by its shop-tz day.
  const byDay = useMemo(() => {
    const map = new Map<string, AgendaRow[]>();
    for (const row of agenda) {
      const key = dayKeyOf(row.start);
      const list = map.get(key) ?? [];
      list.push(row);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.start.localeCompare(b.start));
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agenda, tz]);

  // ---- Visible month + selected day ----
  const [viewYear, setViewYear] = useState(todayParts.y);
  const [viewMonth, setViewMonth] = useState(todayParts.m); // 1-12
  const [selectedDay, setSelectedDay] = useState<string | null>(todayKey);

  // Fetch a month's data on demand (paged to a month we haven't loaded yet).
  function ensureMonthLoaded(year: number, month1to12: number) {
    const tag = `${year}-${month1to12}`;
    if (loadedMonths.has(tag)) return;
    const start = new Date(year, month1to12 - 1, 1);
    const end = new Date(year, month1to12, 0);
    const from = new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(end.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    startMonthLoad(async () => {
      const res = await getAgendaAction(from, to);
      if (!res.ok || !res.data) {
        toast("Couldn't load that month", "error");
        return;
      }
      // Merge new rows in (de-dupe by id, since padding weeks overlap months).
      setAgenda((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        const merged = [...prev];
        for (const r of res.data!.agenda) if (!seen.has(r.id)) merged.push(r);
        return merged;
      });
      setLoadedMonths((prev) => new Set(prev).add(tag));
    });
  }

  function gotoMonth(delta: number) {
    let y = viewYear;
    let m = viewMonth + delta;
    if (m < 1) {
      m = 12;
      y -= 1;
    } else if (m > 12) {
      m = 1;
      y += 1;
    }
    setViewYear(y);
    setViewMonth(m);
    setSelectedDay(null); // collapse the day panel when switching months
    ensureMonthLoaded(y, m);
  }

  // ---- Build the month grid (weeks of 7, Sun-first, incl. leading/trailing) --
  const weeks = useMemo(
    () => buildMonthGrid(viewYear, viewMonth),
    [viewYear, viewMonth],
  );

  // A representative title-date for the month header (noon avoids DST edges).
  const monthTitle = monthTitleFmt.format(new Date(viewYear, viewMonth - 1, 15, 12));

  const selectedRows = selectedDay ? byDay.get(selectedDay) ?? [] : [];

  return (
    <div className="flex flex-col gap-4">
      {/* Waitlist dropdown sits ABOVE the calendar. */}
      <WaitlistPanel initial={initialWaitlist} toast={toast} />

      <Card className="p-4 sm:p-5">
      {/* Month header + nav */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => gotoMonth(-1)}
          aria-label="Previous month"
          className="rounded-lg border border-subtle px-2.5 py-1.5 text-sm text-muted transition-colors hover:text-offwhite"
        >
          ‹
        </button>
        <h2 className="font-display text-lg">
          {monthTitle}
          {pendingMonth && <span className="ml-2 text-xs text-muted">loading…</span>}
        </h2>
        <button
          type="button"
          onClick={() => gotoMonth(1)}
          aria-label="Next month"
          className="rounded-lg border border-subtle px-2.5 py-1.5 text-sm text-muted transition-colors hover:text-offwhite"
        >
          ›
        </button>
      </div>

      {/* Weekday header */}
      <div className="mt-4 grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-muted">
        {WEEKDAY_LABELS.map((w, i) => (
          <div key={i} className="py-1">
            {w}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="mt-1 grid grid-cols-7 gap-1">
        {weeks.flat().map((cell) => {
          if (!cell) return <div key={Math.random()} />;
          const { key, dayNum, inMonth } = cell;
          const rows = byDay.get(key) ?? [];
          const active = rows.filter((r) => r.status !== "canceled").length;
          const isToday = key === todayKey;
          const isSelected = key === selectedDay;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSelectedDay(isSelected ? null : key)}
              className={cn(
                "relative flex aspect-square flex-col items-center justify-center rounded-lg text-sm transition-colors",
                inMonth ? "text-offwhite" : "text-muted/40",
                isSelected
                  ? "bg-gold/20 ring-1 ring-gold/50"
                  : isToday
                    ? "bg-charcoal-700"
                    : "hover:bg-charcoal-700/60",
              )}
            >
              <span className={cn(isToday && !isSelected && "font-semibold text-gold")}>
                {dayNum}
              </span>
              {active > 0 && (
                <span
                  className={cn(
                    "mt-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none",
                    isSelected ? "bg-gold text-charcoal-900" : "bg-gold/20 text-gold",
                  )}
                >
                  {active}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Expanded day planner */}
      <AnimatePresence initial={false}>
        {selectedDay && (
          <motion.div
            key={selectedDay}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <DayPlanner
              rows={selectedRows}
              title={
                selectedRows[0]
                  ? dayTitleFmt.format(new Date(selectedRows[0].start))
                  : selectedDay === todayKey
                    ? dayTitleFmt.format(new Date())
                    : labelFromKey(selectedDay, dayTitleFmt)
              }
              hourOf={(iso) => shopParts(iso).h}
              timeFmt={timeFmt}
              toast={toast}
            />
          </motion.div>
        )}
      </AnimatePresence>
      </Card>
    </div>
  );
}

/**
 * Collapsible "Waitlist (N)" panel above the calendar. Collapsed by default;
 * shows the count as a badge. Each row: who + what they want + how to reach them,
 * with status actions (Contacted / Booked / Remove). REMOVED/BOOKED entries are
 * hidden from the default view (they've been handled).
 */
function WaitlistPanel({
  initial,
  toast,
}: {
  initial: WaitlistRow[];
  toast: Toast;
}) {
  const [open, setOpen] = useState(false);
  // Active = still worth showing (waiting or already contacted, not booked/removed).
  const active = initial.filter((w) => w.status === "WAITING" || w.status === "CONTACTED");
  const waitingCount = initial.filter((w) => w.status === "WAITING").length;

  // Nothing to show and none ever added: hide the panel entirely to avoid clutter.
  if (initial.length === 0) return null;

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <span className="flex items-center gap-2">
          <span className="font-display text-base">Waitlist</span>
          {waitingCount > 0 && (
            <span className="rounded-full bg-gold/15 px-2 py-0.5 text-xs font-semibold text-gold">
              {waitingCount} waiting
            </span>
          )}
        </span>
        <span className="text-muted transition-transform" style={{ transform: open ? "rotate(180deg)" : "none" }}>
          ⌄
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="border-t border-subtle px-5 py-4">
              {active.length === 0 ? (
                <p className="text-sm text-muted">No one waiting right now.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {active.map((w) => (
                    <WaitlistItem key={w.id} entry={w} toast={toast} />
                  ))}
                </ul>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

function WaitlistItem({ entry, toast }: { entry: WaitlistRow; toast: Toast }) {
  const [pending, start] = useTransition();
  const name = `${entry.firstName} ${entry.lastName ?? ""}`.trim() || "Client";
  // What they want: service (+ provider) when known, else their preferred time.
  const wants =
    entry.serviceName || entry.staffName
      ? [entry.serviceName, entry.staffName ? `with ${entry.staffName}` : null]
          .filter(Boolean)
          .join(" ")
      : entry.preferredTime || "any time";

  function setStatus(
    status: "CONTACTED" | "BOOKED" | "REMOVED",
    label: string,
  ) {
    start(async () => {
      const res = await setWaitlistStatusAction(entry.id, status);
      toast(res.ok ? label : "Couldn't update", res.ok ? "success" : "error");
    });
  }

  return (
    <li className="rounded-xl border border-subtle px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium">
            {name}
            {entry.status === "CONTACTED" && (
              <span className="rounded-full bg-charcoal-700 px-2 py-0.5 text-[10px] text-muted">
                contacted
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-muted">{wants}</p>
          {(entry.phone || entry.email) && (
            <p className="mt-1 text-xs">
              {entry.phone && (
                <a href={`sms:${entry.phone}`} className="text-gold hover:underline">
                  {entry.phone}
                </a>
              )}
              {entry.phone && entry.email && <span className="text-muted"> · </span>}
              {entry.email && (
                <a href={`mailto:${entry.email}`} className="text-gold hover:underline">
                  {entry.email}
                </a>
              )}
            </p>
          )}
          {entry.note && <p className="mt-1 text-xs text-muted">“{entry.note}”</p>}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {entry.status !== "CONTACTED" && (
          <button
            onClick={() => setStatus("CONTACTED", "Marked contacted")}
            disabled={pending}
            className="rounded-lg border border-subtle px-3 py-1 text-xs text-muted disabled:opacity-50"
          >
            Contacted
          </button>
        )}
        <button
          onClick={() => setStatus("BOOKED", "Marked booked")}
          disabled={pending}
          className="rounded-lg border border-emerald-soft/40 px-3 py-1 text-xs text-emerald-soft disabled:opacity-50"
        >
          Booked
        </button>
        <button
          onClick={() => setStatus("REMOVED", "Removed")}
          disabled={pending}
          className="rounded-lg border border-danger-soft/40 px-3 py-1 text-xs text-danger-soft disabled:opacity-50"
        >
          Remove
        </button>
      </div>
    </li>
  );
}

/** A single day expanded into an every-hour planner. */
function DayPlanner({
  rows,
  title,
  hourOf,
  timeFmt,
  toast,
}: {
  rows: AgendaRow[];
  title: string;
  hourOf: (iso: string) => number;
  timeFmt: Intl.DateTimeFormat;
  toast: Toast;
}) {
  // Group appointments into their start hour, then render every hour in the
  // day's working window (default 8a-11p, widened to fit any early/late booking).
  const byHour = new Map<number, AgendaRow[]>();
  for (const r of rows) {
    const h = hourOf(r.start);
    byHour.set(h, [...(byHour.get(h) ?? []), r]);
  }
  const bookedHours = [...byHour.keys()];
  // We show each appointment on its START hour, and hours are 0-23, so the window
  // never needs to exceed 23 (an 11 PM cut just needs the 11 PM row to exist -
  // no +1, which would spill into a bogus hour 24 labelled "12 PM").
  const startHour = Math.min(DEFAULT_START_HOUR, ...bookedHours);
  const endHour = Math.min(23, Math.max(DEFAULT_END_HOUR, ...bookedHours));
  const hours: number[] = [];
  for (let h = startHour; h <= endHour; h++) hours.push(h);

  const activeCount = rows.filter((r) => r.status !== "canceled").length;

  return (
    <div className="mt-4 border-t border-subtle pt-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="font-display text-base">{title}</h3>
        <span className="text-xs text-muted">
          {activeCount} {activeCount === 1 ? "appointment" : "appointments"}
        </span>
      </div>

      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="flex flex-col"
      >
        {hours.map((h) => {
          const slot = (byHour.get(h) ?? []).sort((a, b) => a.start.localeCompare(b.start));
          return (
            <motion.div
              key={h}
              variants={fadeUp}
              className="flex gap-3 border-b border-subtle/60 py-2 last:border-b-0"
            >
              <div className="w-14 shrink-0 pt-0.5 text-right text-[11px] font-medium text-muted">
                {formatHour(h)}
              </div>
              <div className="min-w-0 flex-1">
                {slot.length === 0 ? (
                  <div className="py-1 text-xs text-muted/40">— open —</div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {slot.map((r) => (
                      <AppointmentBlock
                        key={r.id}
                        row={r}
                        // Show the time RANGE so the barber sees how long each
                        // cut runs. Guard the cases that specifically hit synced/
                        // manual visits: no end, or a zero-length end (== start) -
                        // both fall back to just the start time (no bogus "2–2").
                        timeLabel={
                          r.end && r.end !== r.start
                            ? `${timeFmt.format(new Date(r.start))}–${timeFmt.format(new Date(r.end))}`
                            : timeFmt.format(new Date(r.start))
                        }
                        toast={toast}
                      />
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          );
        })}
      </motion.div>
    </div>
  );
}

const STATUS_PILL: Record<AgendaRow["status"], { label: string; cls: string }> = {
  upcoming: { label: "Upcoming", cls: "bg-gold/15 text-gold" },
  completed: { label: "Done", cls: "bg-emerald-soft/15 text-emerald-soft" },
  canceled: { label: "Canceled", cls: "bg-charcoal-700 text-muted" },
  no_show: { label: "No-show", cls: "bg-danger-soft/15 text-danger-soft" },
};

function AppointmentBlock({
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
  const canAct = row.source === "appointment" && row.status === "upcoming";

  function act(fn: (id: string) => Promise<{ ok: boolean }>, label: string) {
    start(async () => {
      const res = await fn(row.id);
      toast(res.ok ? label : "Couldn't update", res.ok ? "success" : "error");
    });
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-subtle bg-charcoal-800/40 px-3 py-2",
        row.status === "canceled" && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium">
            <span className="tabular-nums text-muted">{timeLabel}</span>
            <span className="truncate">{row.clientName || "Client"}</span>
          </p>
          {/* The haircut / service type + price. */}
          <p className="mt-0.5 truncate text-xs text-muted">
            {row.serviceName ?? "Appointment"}
            {row.price != null && ` · $${row.price.toFixed(0)}`}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
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
            className="rounded-md border border-emerald-soft/40 px-2.5 py-1 text-[11px] text-emerald-soft disabled:opacity-50"
          >
            Done
          </button>
          <button
            onClick={() => act(noShowAppointmentAction, "Marked no-show")}
            disabled={pending}
            className="rounded-md border border-subtle px-2.5 py-1 text-[11px] text-muted disabled:opacity-50"
          >
            No-show
          </button>
          <button
            onClick={() => act(cancelAppointmentAction, "Canceled")}
            disabled={pending}
            className="rounded-md border border-danger-soft/40 px-2.5 py-1 text-[11px] text-danger-soft disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

//  helpers

type Cell = { key: string; dayNum: number; inMonth: boolean } | null;

/** Build a month as weeks of 7 cells (Sun-first), incl. leading/trailing days. */
function buildMonthGrid(year: number, month1to12: number): Cell[][] {
  const first = new Date(year, month1to12 - 1, 1);
  const startWeekday = first.getDay(); // 0=Sun
  const daysInMonth = new Date(year, month1to12, 0).getDate();
  const daysInPrev = new Date(year, month1to12 - 1, 0).getDate();

  const cells: Cell[] = [];
  // Leading days from the previous month.
  for (let i = 0; i < startWeekday; i++) {
    const d = daysInPrev - startWeekday + 1 + i;
    const pm = month1to12 === 1 ? 12 : month1to12 - 1;
    const py = month1to12 === 1 ? year - 1 : year;
    cells.push({ key: keyOf(py, pm, d), dayNum: d, inMonth: false });
  }
  // This month.
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ key: keyOf(year, month1to12, d), dayNum: d, inMonth: true });
  }
  // Trailing days to complete the last week.
  while (cells.length % 7 !== 0) {
    const idx = cells.length - (startWeekday + daysInMonth) + 1;
    const nm = month1to12 === 12 ? 1 : month1to12 + 1;
    const ny = month1to12 === 12 ? year + 1 : year;
    cells.push({ key: keyOf(ny, nm, idx), dayNum: idx, inMonth: false });
  }

  const weeks: Cell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function keyOf(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Label a YYYY-MM-DD key for an EMPTY day (no real instant to format). Builds a
 *  local noon Date from the parts so the weekday/month are correct. */
function labelFromKey(key: string, fmt: Intl.DateTimeFormat): string {
  const [y, m, d] = key.split("-").map(Number);
  return fmt.format(new Date(y!, m! - 1, d!, 12));
}

/** "8 AM", "12 PM", "5 PM" from a 0-23 hour. */
function formatHour(h: number): string {
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${period}`;
}
