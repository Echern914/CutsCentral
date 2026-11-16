"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { cap, useVocab } from "@/components/VocabProvider";
import { cn } from "@/lib/cn";
import { fmtDuration } from "@/lib/duration";
import { appointmentStatusPill, initialsOf } from "../_components/appointmentCardStyles";
import { Fact, type SheetView } from "./AppointmentSheet";
import { dayTotals } from "./dayTotals";
import type { AgendaRow, StaffRow } from "./page";
import { HOUR_PX, placeDay, spanOf, topPx, weekHourWindow } from "./weekLayout";

/**
 * THE WEEK, ON A DESKTOP. Seven columns at 72px an hour, so a 30-minute cut is
 * tall enough for a name and its time, and a booking's place on the page IS
 * its time. Offered only where seven columns of names fit (BookingCalendar
 * decides); a phone keeps Day and Month.
 *
 * Reads the calendar's loaded rows and writes nothing itself. A booking opens
 * the same AppointmentSheet every other surface opens, and an empty time opens
 * the same New appointment form, so the week adds a way of LOOKING, never a
 * second way of booking or checking out.
 *
 * At 1400px and up the picked booking docks in a panel beside the grid, so the
 * barber can read through a week without a sheet covering it. Narrower, a
 * click opens the sheet straight away.
 */
export interface WeekDay {
  key: string;
  /** Bookings that day, counted as the week strip counts them (no blocks, no cancellations). */
  count: number;
}

const COLS = "grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]";
// The hour rules, in the hairline token itself: drawn as a background so a
// column is one element, and a click on it lands on the column, not a rule.
const HOUR_RULES = {
  backgroundImage: "linear-gradient(rgb(var(--cb-fg) / var(--cb-border-a)) 1px, transparent 1px)",
  backgroundSize: `100% ${HOUR_PX}px`,
};
const STRIPES =
  "bg-[repeating-linear-gradient(-45deg,transparent,transparent_6px,rgb(var(--cb-fg)/0.06)_6px,rgb(var(--cb-fg)/0.06)_12px)]";
/** Where the panel docks. Narrower, the days need the width and a booking opens its sheet. */
const DOCK_QUERY = "(min-width: 1400px)";

/**
 * A booking's edge says its state, from the same reading as its status pill:
 * a request asks (warm fill), paid or finished is green, on the way is blue,
 * and a plain booking stays quiet. The picked one is ink, like the board.
 */
function toneOf(row: AgendaRow, picked: boolean): string {
  if (picked) return "z-20 border-l-gold bg-primary text-on-primary shadow-ambient-lg";
  if (row.status === "pending") return "border-l-warning-soft bg-warning-soft/15 text-offwhite";
  if (row.status === "no_show") return "border-l-danger-soft bg-charcoal-700 text-muted";
  if (row.status === "completed" || row.paid != null || row.checkInStatus === "arrived") {
    return "border-l-emerald-soft bg-charcoal-700 text-offwhite";
  }
  if (row.checkInStatus === "en_route") return "border-l-info-soft bg-charcoal-700 text-offwhite";
  return "border-l-subtle-strong bg-charcoal-700 text-offwhite";
}

const keyDate = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!, 12);
};
const WEEKDAY_SHORT = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const WEEKDAY_LONG = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" });

function hourLabel(h: number): string {
  if (h === 0 || h === 24) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}


export function WeekView({
  days,
  rowsByDay,
  todayKey,
  timeZone,
  timeFmt,
  minuteOf,
  staff,
  isNative,
  onOpen,
  onOpenBlock,
  onOpenDay,
  onAddAt,
  onNew,
  onBlock,
}: {
  /** The seven days shown, in order. */
  days: WeekDay[];
  rowsByDay: Map<string, AgendaRow[]>;
  todayKey: string;
  timeZone: string;
  /** Shop-zone time formatter ("9:30 AM"). */
  timeFmt: Intl.DateTimeFormat;
  /** Shop wall-clock minute of the day (0-1439) of an instant. */
  minuteOf: (iso: string) => number;
  staff: StaffRow[];
  isNative: boolean;
  onOpen: (row: AgendaRow, view: SheetView) => void;
  onOpenBlock: (row: AgendaRow, dayKey: string) => void;
  /** Open one day in the Day view (a day's header). */
  onOpenDay: (dayKey: string) => void;
  /** An empty time was clicked (native booking only). */
  onAddAt?: (dayKey: string, hour: number, minute: number) => void;
  onNew?: () => void;
  onBlock?: () => void;
}) {
  const vocab = useVocab();
  const [picked, setPicked] = useState<{ id: string; source: AgendaRow["source"] } | null>(null);

  // The now line moves with the clock.
  const [nowIso, setNowIso] = useState(() => new Date().toISOString());
  useEffect(() => {
    const iv = setInterval(() => setNowIso(new Date().toISOString()), 60_000);
    return () => clearInterval(iv);
  }, []);

  // A cancelled booking gave its time back, so it leaves the grid.
  const shown = useMemo(
    () =>
      days.map((d) => {
        const rows = (rowsByDay.get(d.key) ?? []).filter((r) => r.status !== "canceled");
        return {
          ...d,
          blocks: rows.filter((r) => r.source === "block"),
          bookings: rows.filter((r) => r.source !== "block"),
        };
      }),
    [days, rowsByDay],
  );
  const all = shown.flatMap((d) => [...d.blocks, ...d.bookings]);
  const { startHour, endHour } = weekHourWindow(all.map((r) => spanOf(r, minuteOf)));
  const gridPx = (endHour - startHour) * HOUR_PX;
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const totals = dayTotals(all);
  const bookedCount = days.reduce((n, d) => n + d.count, 0);

  const todayIdx = shown.findIndex((d) => d.key === todayKey);
  const nowMin = minuteOf(nowIso);
  const nowShown = todayIdx >= 0 && nowMin >= startHour * 60 && nowMin <= endHour * 60;

  // Open each week at the part worth reading: an hour before now on this week,
  // otherwise just above its first booking. Once per week shown - a poll must
  // not pull the grid back while the barber is reading further down.
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstKey = days[0]?.key;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const earliest = Math.min(Infinity, ...shown.flatMap((d) => d.bookings.map((r) => minuteOf(r.start))));
    const anchor =
      todayIdx >= 0 ? nowMin - 60 : Number.isFinite(earliest) ? earliest - 30 : startHour * 60;
    el.scrollTop = Math.max(0, topPx(anchor, startHour));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstKey]);

  const pickedRow = picked
    ? (shown.flatMap((d) => d.bookings).find((r) => r.id === picked.id && r.source === picked.source) ??
      null)
    : null;

  const pick = (row: AgendaRow) => {
    const docked = typeof window !== "undefined" && (window.matchMedia?.(DOCK_QUERY).matches ?? false);
    if (docked) setPicked({ id: row.id, source: row.source });
    else onOpen(row, "detail");
  };

  // An empty time books that time, to the quarter hour above the click.
  const clickColumn = (dayKey: string) => (e: MouseEvent<HTMLDivElement>) => {
    if (!onAddAt || e.target !== e.currentTarget) return;
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    const minute = startHour * 60 + Math.floor(((y / HOUR_PX) * 60) / 15) * 15;
    if (minute < 0 || minute >= 24 * 60) return;
    onAddAt(dayKey, Math.floor(minute / 60), minute % 60);
  };

  const timeOf = (iso: string) => timeFmt.format(new Date(iso));

  return (
    <div className="mt-4" data-qa="week-view">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted tabular-nums" data-qa="week-totals">
          <span className="font-semibold text-offwhite">{bookedCount} booked</span>
          {totals.revenue > 0 && <> · ${Math.round(totals.revenue).toLocaleString()} on the books</>}
          {totals.blockedMin > 0 && <> · {fmtDuration(totals.blockedMin)} off</>}
        </p>
        {isNative && (
          <div className="flex items-center gap-2">
            {onBlock && (
              <button
                type="button"
                onClick={onBlock}
                className="h-10 rounded-lg border border-subtle px-3.5 text-sm font-semibold text-offwhite transition-colors hover:bg-charcoal-700/60"
              >
                Block off time
              </button>
            )}
            {onNew && (
              <button
                type="button"
                onClick={onNew}
                className="h-10 rounded-lg bg-primary px-3.5 text-sm font-semibold text-on-primary transition-opacity hover:opacity-90"
              >
                New appointment
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-subtle bg-charcoal-800">
          <div
            ref={scrollRef}
            data-qa="week-scroll"
            className="max-h-[min(72vh,50rem)] overflow-y-auto overscroll-contain"
          >
            {/* Day headers stay put while the hours scroll under them. */}
            <div className={cn(COLS, "sticky top-0 z-30 border-b border-subtle bg-charcoal-800")}>
              <div />
              {shown.map((d) => {
                const date = keyDate(d.key);
                const isToday = d.key === todayKey;
                return (
                  <button
                    key={d.key}
                    type="button"
                    onClick={() => onOpenDay(d.key)}
                    aria-label={`Open ${WEEKDAY_LONG.format(date)}`}
                    data-qa="week-day-head"
                    className="flex min-w-0 flex-col items-start gap-0.5 border-l border-subtle px-2.5 py-2 text-left transition-colors hover:bg-charcoal-700/60"
                  >
                    <span className={cn("text-xs font-medium", isToday ? "text-gold" : "text-muted")}>
                      {WEEKDAY_SHORT.format(date)}
                    </span>
                    <span
                      className={cn(
                        "font-display text-xl font-semibold leading-7 tabular-nums",
                        isToday &&
                          "-ml-1.5 inline-flex min-w-[1.75rem] items-center justify-center rounded-full bg-primary px-1.5 text-on-primary",
                      )}
                    >
                      {date.getDate()}
                    </span>
                    <span className="w-full truncate text-xs text-muted">
                      {d.count > 0 ? `${d.count} booked` : "No bookings"}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className={COLS}>
              {/* The hour gutter. */}
              <div className="relative" style={{ height: gridPx }} aria-hidden>
                {hours.map((h, i) => (
                  <span
                    key={h}
                    className="absolute right-2 text-[11px] leading-[14px] text-muted tabular-nums"
                    style={{ top: i * HOUR_PX + 4 }}
                  >
                    {hourLabel(h)}
                  </span>
                ))}
              </div>

              {shown.map((d, dayIdx) => {
                const blocks = d.blocks.map((r) => ({ row: r, span: spanOf(r, minuteOf) }));
                const placed = placeDay(d.bookings, (r) => spanOf(r, minuteOf), startHour);
                return (
                  <div
                    key={d.key}
                    data-qa="week-col"
                    className={cn(
                      "relative border-l border-subtle",
                      d.key === todayKey && "bg-gold/[0.03]",
                      onAddAt && "cursor-pointer",
                    )}
                    style={{ height: gridPx, ...HOUR_RULES }}
                    onClick={clickColumn(d.key)}
                    title={onAddAt ? "Click an empty time to book it" : undefined}
                  >
                    {blocks.map(({ row, span }) => (
                      <button
                        key={`b:${row.id}`}
                        type="button"
                        onClick={() => onOpenBlock(row, d.key)}
                        data-qa="week-block"
                        aria-label={`Blocked ${timeOf(row.start)}${row.clientName && row.clientName !== "Blocked" ? `, ${row.clientName}` : ""}`}
                        className={cn(
                          "absolute inset-x-0 overflow-hidden border-l-[3px] border-l-subtle-strong bg-charcoal-700/50 px-2 py-0.5 text-left text-xs leading-4 text-muted",
                          STRIPES,
                        )}
                        style={{
                          top: topPx(span.startMin, startHour),
                          height: Math.max(((span.endMin - span.startMin) / 60) * HOUR_PX, 18),
                        }}
                      >
                        <span className="block truncate font-medium">
                          Blocked
                          {row.clientName && row.clientName !== "Blocked" ? ` · ${row.clientName}` : ""}
                        </span>
                      </button>
                    ))}

                    {placed.map(({ item: row, top, height, lane, lanes }) => {
                      const isPicked = pickedRow?.id === row.id && pickedRow.source === row.source;
                      const pill = appointmentStatusPill({
                        status: row.status,
                        checkInStatus: row.checkInStatus,
                        etaMinutes: row.etaMinutes,
                        runningLate: row.runningLate,
                      });
                      const time = timeOf(row.start);
                      return (
                        <button
                          key={`${row.source}:${row.id}`}
                          type="button"
                          onClick={() => pick(row)}
                          data-qa="week-event"
                          aria-pressed={isPicked}
                          aria-label={[row.clientName, time, row.serviceName, pill.label].filter(Boolean).join(", ")}
                          className={cn(
                            "absolute z-10 overflow-hidden rounded-md border-l-[3px] px-2 py-0.5 text-left text-xs leading-4 transition-shadow hover:shadow-ambient",
                            toneOf(row, isPicked),
                          )}
                          style={{
                            top,
                            height,
                            left: `calc(${(lane / lanes) * 100}% + 3px)`,
                            width: `calc(${100 / lanes}% - 6px)`,
                          }}
                        >
                          <span
                            className={cn(
                              "block truncate text-[13px] font-semibold leading-[17px]",
                              row.status === "no_show" && "line-through",
                            )}
                          >
                            {row.clientName}
                          </span>
                          {height >= 36 && (
                            <span className={cn("block truncate tabular-nums", isPicked ? "opacity-80" : "text-muted")}>
                              {time}
                              {row.serviceName ? ` · ${row.serviceName}` : ""}
                            </span>
                          )}
                        </button>
                      );
                    })}

                    {nowShown && dayIdx === todayIdx && (
                      <div
                        aria-hidden
                        data-qa="week-now"
                        className="pointer-events-none absolute inset-x-0 z-20 h-0.5 bg-danger-soft"
                        style={{ top: topPx(nowMin, startHour) - 1 }}
                      >
                        <span className="absolute -left-1 -top-[3px] h-2 w-2 rounded-full bg-danger-soft" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <aside data-qa="week-inspector" className="hidden w-80 flex-none min-[1400px]:block">
          {pickedRow ? (
            <Inspector
              row={pickedRow}
              timeZone={timeZone}
              timeOf={timeOf}
              provider={staff.find((s) => s.id === pickedRow.staffId)?.name ?? null}
              providerNoun={cap(vocab.providerNoun)}
              onOpen={onOpen}
            />
          ) : (
            <div className="rounded-2xl border border-dashed border-subtle-strong px-4 py-6 text-sm leading-relaxed text-muted">
              Pick an appointment to see it here.
              {isNative && " Click an empty time to book one."}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * The picked booking, docked. Only what the calendar row already knows - the
 * full record (contact, history, money ledger) loads in the sheet these buttons
 * open, which stays the one place a booking is changed or checked out.
 */
function Inspector({
  row,
  timeZone,
  timeOf,
  provider,
  providerNoun,
  onOpen,
}: {
  row: AgendaRow;
  timeZone: string;
  timeOf: (iso: string) => string;
  provider: string | null;
  providerNoun: string;
  onOpen: (row: AgendaRow, view: SheetView) => void;
}) {
  const pill = appointmentStatusPill({
    status: row.status,
    checkInStatus: row.checkInStatus,
    etaMinutes: row.etaMinutes,
    runningLate: row.runningLate,
  });
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(row.start));
  const owed =
    row.price != null ? Math.max(0, row.price - (row.prepaid ?? 0) - (row.paid ?? 0)) : null;
  // The sheet re-checks everything (who took the booking, whether it is
  // already checked out); this only decides whether to offer the button.
  const canCheckout =
    row.source === "appointment" &&
    !row.syncedExternal &&
    (row.status === "upcoming" || row.status === "completed") &&
    row.paid == null;
  const note = row.notes?.trim();

  return (
    <div className="overflow-hidden rounded-2xl border border-subtle bg-charcoal-800" data-qa="week-picked">
      <div className="flex items-start gap-3 px-4 pb-3.5 pt-4">
        <span
          aria-hidden
          className={cn(
            "flex h-12 w-12 flex-none items-center justify-center rounded-full bg-charcoal-700 font-display text-base font-semibold text-offwhite ring-2",
            pill.ringCls,
          )}
        >
          {initialsOf(row.clientName)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-xl leading-7 text-offwhite [overflow-wrap:anywhere]">
            {row.clientName}
          </p>
          <span className={cn("mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-medium", pill.cls)}>
            {pill.label}
          </span>
        </div>
      </div>
      <dl className="border-t border-subtle text-sm">
        <Fact label="When">
          <span className="tabular-nums">{dateLabel}</span>
          <span className="block tabular-nums">
            {timeOf(row.start)}
            {row.end ? ` – ${timeOf(row.end)}` : ""}
          </span>
        </Fact>
        <Fact label="Service">
          <span className="[overflow-wrap:anywhere]">
            {row.serviceName ?? "Appointment"}
            {(row.addOns ?? []).map((a) => ` + ${a.name}`).join("")}
          </span>
        </Fact>
        {provider && (
          <Fact label={providerNoun}>
            <span className="[overflow-wrap:anywhere]">{provider}</span>
          </Fact>
        )}
        <Fact label="Price">
          <span className="tabular-nums">{row.price != null ? `$${row.price.toFixed(2)}` : "Not priced"}</span>
        </Fact>
        {row.paid != null ? (
          <Fact label="Paid">
            <span className="tabular-nums">${row.paid.toFixed(2)}</span>
          </Fact>
        ) : (row.prepaid ?? 0) > 0 && owed != null ? (
          <Fact label="Still due">
            <span className="tabular-nums">${owed.toFixed(2)}</span>
          </Fact>
        ) : null}
      </dl>
      {note && (
        <div className="border-t border-subtle px-4 py-3">
          <p className="text-[13px] font-semibold text-muted">Note</p>
          <p className="mt-1 whitespace-pre-line text-sm text-offwhite [overflow-wrap:anywhere]">{note}</p>
        </div>
      )}
      <div className="flex flex-col gap-2 border-t border-subtle p-4">
        {canCheckout && (
          <button
            type="button"
            onClick={() => onOpen(row, "charges")}
            data-qa="week-checkout"
            className="h-[3.25rem] rounded-xl bg-primary px-4 text-base font-semibold text-on-primary transition-opacity hover:opacity-90"
          >
            Check out{owed ? ` · $${owed.toFixed(2)}` : ""}
          </button>
        )}
        <button
          type="button"
          onClick={() => onOpen(row, "detail")}
          data-qa="week-open"
          className="h-11 rounded-xl border border-subtle px-4 text-sm font-semibold text-offwhite transition-colors hover:border-subtle-strong hover:bg-charcoal-700/60"
        >
          Open appointment
        </button>
      </div>
    </div>
  );
}
