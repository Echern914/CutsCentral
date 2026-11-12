"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { zonedDateKey } from "@chairback/config/time";
import type { StoredDateHours } from "@chairback/config/servicePricing";
import {
  compareSpans,
  dateHoursProblem,
  dateHoursSentence,
  dateLabel,
  deltaLabel,
  hhmmToMinute,
  hoursDelta,
  minuteToHhmm,
  spansLabel,
  usualSpans,
  weekdayOfDateKey,
  type Span,
} from "@chairback/config/dateHoursPlan";
import { FormError } from "@/components/ui/FormError";
import { MIDNIGHT_END, TimeSelect } from "@/components/ui/TimeSelect";
import { MoneyField } from "@/components/ui/UnitField";
import { cn } from "@/lib/cn";
import { Sheet } from "./AppointmentForm";
import { getAvailabilityAction, setServiceDateHoursAction } from "./actions";
import type { ServiceRow, StaffRow } from "./page";

/**
 * CHANGE SOME DAYS - one service, its own hours on the days the barber picks.
 *
 * A barber asked for longer hours for men's haircuts on the days of
 * Thanksgiving week "without messing with anything else". This is that, said
 * the way he said it: WHICH DAYS, then WHAT HOURS, then the change read back
 * as a sentence before anything is saved.
 *
 *   - Several days in one save. A holiday week is one decision, not four.
 *   - Hours can be split, so a break in the middle of the day stays closed.
 *   - "What changes" draws each day's usual hours against the new ones, so
 *     the barber sees what he is adding (or taking away) before he saves. It
 *     is drawn only when the change is about ONE person's day - with several
 *     staff there is no single "usual" to compare against.
 *   - Only this service changes. That is the server's rule (the slot engine
 *     replaces this service's day and nothing else); the sheet just says so.
 *
 * 🔴 The outcome is shown IN the sheet, above the buttons - a toast raised
 * from inside a dialog sits behind it on a phone.
 */

type DateService = Pick<
  ServiceRow,
  "id" | "name" | "price" | "dateOverrides" | "hoursWindows" | "timeOverrides"
> & {
  dateHours?: StoredDateHours;
  staffIds?: string[];
};

interface Row {
  start: string;
  end: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_ROWS = 6;
const DEFAULT_ROW: Row = { start: "09:00", end: "17:00" };

const timeCls =
  "min-h-[44px] flex-1 rounded-xl border border-subtle bg-charcoal-700 px-2.5 text-sm font-medium text-offwhite outline-none focus:border-gold/50";
const sectionLabel = "text-xs font-semibold uppercase tracking-wider text-muted";

/** "YYYY-MM-DD" plus n days. A calendar date, so plain UTC arithmetic is exact. */
function addDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const weekStartOf = (dateKey: string) => addDays(dateKey, -weekdayOfDateKey(dateKey));
const dayOf = (dateKey: string) => Number(dateKey.slice(8));
const monthOf = (dateKey: string) => MONTHS[Number(dateKey.slice(5, 7)) - 1]!;

function rowsToSpans(rows: Row[]): Span[] | null {
  const out: Span[] = [];
  for (const r of rows) {
    const s = hhmmToMinute(r.start);
    const e = hhmmToMinute(r.end);
    if (s === null || e === null) return null;
    out.push({ startMin: s, endMin: e });
  }
  return out;
}

/** What the server said, in words a barber can act on. */
function refusalCopy(error: string | undefined): string {
  switch (error) {
    case "past_date":
      return "One of those days has already passed. Take it off and save again.";
    case "overlapping_hours":
      return "Two of the hours overlap. Fix them and save again.";
    case "unknown_staff":
      return "Someone picked no longer does this service. Reopen this and try again.";
    case "too_many_dates":
      return "This service already has the most special dates it can hold. Undo some first.";
    case "not_found":
      return "This service is no longer there. Close this and refresh.";
    default:
      return "That didn't save. Check your connection and try again.";
  }
}

export function ServiceDatesSheet({
  service,
  staff,
  timezone,
  onClose,
  onSaved,
}: {
  service: DateService;
  staff: StaffRow[];
  timezone: string;
  onClose: () => void;
  /** The service's dated hours and prices as the server now holds them. */
  onSaved?: (dateHours: StoredDateHours, dateOverrides: Record<string, number>) => void;
}) {
  const today = useMemo(() => zonedDateKey(new Date(), timezone), [timezone]);
  // The people who actually do this service. One of them = a solo setup, and
  // the "who" question is never asked.
  const offering = useMemo(
    () => staff.filter((s) => s.active && (service.staffIds ?? []).includes(s.id)),
    [staff, service.staffIds],
  );

  // What the server holds, kept current from each save's own answer rather
  // than waiting for the page to refetch.
  const [saved, setSaved] = useState<StoredDateHours>(service.dateHours ?? {});
  const [prices, setPrices] = useState<Record<string, number>>(service.dateOverrides ?? {});

  const [weekStart, setWeekStart] = useState(() => weekStartOf(today));
  const [picked, setPicked] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([DEFAULT_ROW]);
  const [rowsTouched, setRowsTouched] = useState(false);
  const [closed, setClosed] = useState(false);
  const [price, setPrice] = useState("");
  const [priceTouched, setPriceTouched] = useState(false);
  const [who, setWho] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  // A ref as well as state: two taps in one frame both read the same `busy`.
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // The one person whose usual day the comparison can be drawn against.
  const subject = who.length === 1 ? who[0]! : offering.length === 1 ? offering[0]!.id : null;
  const [rulesBy, setRulesBy] = useState<Record<string, { weekday: number; startMin: number; endMin: number }[]>>({});
  useEffect(() => {
    if (!subject || rulesBy[subject]) return;
    let live = true;
    void getAvailabilityAction(subject).then((res) => {
      if (live && res.ok && res.data) setRulesBy((cur) => ({ ...cur, [subject]: res.data!.rules }));
    });
    return () => {
      live = false;
    };
  }, [subject, rulesBy]);
  const rules = subject ? rulesBy[subject] : undefined;

  const usualFor = useCallback(
    (dateKey: string): Span[] | null =>
      rules
        ? usualSpans({
            weekday: weekdayOfDateKey(dateKey),
            staffRules: rules,
            hoursWindows: service.hoursWindows,
            timeOverrides: service.timeOverrides,
          })
        : null,
    [rules, service.hoursWindows, service.timeOverrides],
  );

  // Start the hours from the first picked day's usual ones, so "open earlier"
  // is one change to the start time - until the barber has touched them.
  useEffect(() => {
    if (rowsTouched || picked.length === 0) return;
    const usual = usualFor([...picked].sort()[0]!);
    if (usual && usual.length > 0) {
      setRows(usual.slice(0, MAX_ROWS).map((s) => ({ start: minuteToHhmm(s.startMin), end: minuteToHhmm(s.endMin) })));
    }
  }, [picked, rowsTouched, usualFor]);

  const spans = closed ? [] : rowsToSpans(rows);
  const problem = closed || !spans ? null : dateHoursProblem(spans);
  const sortedPicked = useMemo(() => [...picked].sort(), [picked]);

  // The price to read back: what was typed, else one the days already share.
  const existingPrice = useMemo(() => {
    const values = [...new Set(sortedPicked.map((d) => prices[d]))];
    return values.length === 1 && values[0] !== undefined ? values[0] : null;
  }, [sortedPicked, prices]);
  const typedPrice = price.trim() === "" ? null : Number(price);
  const priceBad = typedPrice !== null && (!Number.isFinite(typedPrice) || typedPrice < 0);
  const shownPrice = priceTouched ? typedPrice : existingPrice;

  const scopedNames = who.length > 0 ? offering.filter((s) => who.includes(s.id)).map((s) => s.name) : [];
  const sentence =
    spans && !problem && !priceBad
      ? dateHoursSentence({
          serviceName: service.name,
          dates: sortedPicked,
          hours: spans,
          price: shownPrice,
          staffNames: scopedNames,
        })
      : "";

  const canSave = sortedPicked.length > 0 && spans !== null && !problem && !priceBad && (closed || rows.length > 0);

  function togglePicked(dateKey: string) {
    setNote(null);
    setError(null);
    setPicked((cur) => (cur.includes(dateKey) ? cur.filter((d) => d !== dateKey) : [...cur, dateKey]));
  }

  function patchRow(i: number, patch: Partial<Row>) {
    setRowsTouched(true);
    setNote(null);
    setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  /** Load a saved day back into the controls, to change it. */
  function edit(dateKey: string) {
    const entry = saved[dateKey];
    if (!entry) return;
    setNote(null);
    setError(null);
    setPicked([dateKey]);
    setWeekStart(weekStartOf(dateKey));
    setRowsTouched(true);
    setClosed(entry.w.length === 0);
    setRows(
      entry.w.length > 0
        ? entry.w.map((w) => ({ start: minuteToHhmm(w.s), end: minuteToHhmm(w.e) }))
        : [DEFAULT_ROW],
    );
    setWho(entry.staff.filter((id) => offering.some((s) => s.id === id)));
    setPrice(prices[dateKey] !== undefined ? String(prices[dateKey]) : "");
    setPriceTouched(false);
  }

  async function send(body: Parameters<typeof setServiceDateHoursAction>[1], done: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await setServiceDateHoursAction(service.id, body);
      if (!res.ok || !res.dateHours) {
        setError(refusalCopy(res.error));
        return;
      }
      setSaved(res.dateHours);
      setPrices(res.dateOverrides ?? {});
      onSaved?.(res.dateHours, res.dateOverrides ?? {});
      setNote(done);
      setPicked([]);
      setRowsTouched(false);
      setPriceTouched(false);
      setPrice("");
    } catch {
      setError(refusalCopy(undefined));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function save() {
    if (!canSave || !spans) return;
    void send(
      {
        dates: sortedPicked,
        hours: spans.map((s) => ({ s: s.startMin, e: s.endMin })),
        ...(offering.length > 1 ? { staffIds: who } : {}),
        // Untouched = leave any price already on those days exactly as it is.
        ...(priceTouched ? { price: typedPrice } : {}),
      },
      `Saved. ${sentence}`,
    );
  }

  function undo(dateKey: string) {
    void send({ dates: [dateKey], hours: null }, `${dateLabel(dateKey)} is back to its usual hours.`);
  }

  const upcoming = Object.keys(saved)
    .filter((d) => d >= today)
    .sort();
  const week = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const weekLabel =
    monthOf(week[0]!) === monthOf(week[6]!)
      ? `${monthOf(week[0]!)} ${dayOf(week[0]!)} – ${dayOf(week[6]!)}`
      : `${monthOf(week[0]!)} ${dayOf(week[0]!)} – ${monthOf(week[6]!)} ${dayOf(week[6]!)}`;
  const canGoBack = weekStart > weekStartOf(today);

  // The comparison: one bar per picked day, on a scale wide enough for all.
  const bars =
    rules && spans && !problem
      ? sortedPicked.map((d) => {
          const usual = usualFor(d) ?? [];
          return { date: d, ...compareSpans(usual, spans), delta: deltaLabel(hoursDelta(usual, spans)) };
        })
      : [];
  const scale = useMemo(() => {
    const all = bars.flatMap((b) => [...b.kept, ...b.added, ...b.removed]);
    const lo = Math.min(8 * 60, ...all.map((s) => s.startMin));
    const hi = Math.max(20 * 60, ...all.map((s) => s.endMin));
    const start = Math.floor(lo / 60) * 60;
    const end = Math.ceil(hi / 60) * 60;
    return { start, end, size: end - start };
  }, [bars]);
  const place = (s: Span) => ({
    left: `${((s.startMin - scale.start) / scale.size) * 100}%`,
    width: `${((s.endMin - s.startMin) / scale.size) * 100}%`,
  });
  const anyRemoved = bars.some((b) => b.removed.length > 0);
  const hourTick = (min: number) => `${(min / 60) % 12 === 0 ? 12 : (min / 60) % 12} ${min < 720 || min === 1440 ? "AM" : "PM"}`;

  return (
    <Sheet title={`${service.name}: change some days`} onClose={onClose}>
      <div className="flex flex-col gap-5">
        <p className="text-sm leading-relaxed text-muted">
          Give {service.name} its own hours on the days you pick. Everything else you offer keeps its usual day.
        </p>

        {upcoming.length > 0 && (
          <section aria-label="Days already changed" className="flex flex-col gap-2">
            <h3 className={sectionLabel}>Already changed</h3>
            <ul className="divide-y divide-subtle overflow-hidden rounded-xl border border-subtle">
              {upcoming.map((d) => {
                const entry = saved[d]!;
                const hours =
                  entry.w.length === 0
                    ? "Not offered"
                    : spansLabel(entry.w.map((w) => ({ startMin: w.s, endMin: w.e })));
                const names = entry.staff
                  .map((id) => staff.find((s) => s.id === id)?.name)
                  .filter((n): n is string => Boolean(n));
                return (
                  <li key={d} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-offwhite">{dateLabel(d)}</div>
                      <div className="text-xs text-muted [overflow-wrap:anywhere]">
                        {hours}
                        {prices[d] !== undefined ? ` · $${prices[d]}` : ""}
                        {names.length > 0 ? ` · ${names.join(", ")}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => edit(d)}
                      disabled={busy}
                      className="min-h-[44px] rounded-lg px-2 text-xs font-medium text-gold hover:underline disabled:opacity-50"
                      aria-label={`Change ${dateLabel(d)}`}
                    >
                      Change
                    </button>
                    <button
                      type="button"
                      onClick={() => undo(d)}
                      disabled={busy}
                      className="min-h-[44px] rounded-lg px-2 text-xs font-medium text-muted hover:text-danger-soft hover:underline disabled:opacity-50"
                      aria-label={`Put ${dateLabel(d)} back to its usual hours`}
                    >
                      Undo
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className={sectionLabel}>
              Which days <span className="normal-case tracking-normal">{`· ${weekLabel}`}</span>
            </h3>
            <div className="flex">
              <button
                type="button"
                onClick={() => setWeekStart((w) => addDays(w, -7))}
                disabled={!canGoBack}
                aria-label="Earlier week"
                className="flex h-11 w-11 items-center justify-center rounded-lg text-offwhite disabled:opacity-30"
              >
                <span aria-hidden="true">{"‹"}</span>
              </button>
              <button
                type="button"
                onClick={() => setWeekStart((w) => addDays(w, 7))}
                aria-label="Later week"
                className="flex h-11 w-11 items-center justify-center rounded-lg text-offwhite"
              >
                <span aria-hidden="true">{"›"}</span>
              </button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-1.5">
            {week.map((d) => {
              const on = picked.includes(d);
              const past = d < today;
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => togglePicked(d)}
                  disabled={past}
                  aria-pressed={on}
                  aria-label={`${dateLabel(d)}${saved[d] ? ", already changed" : ""}`}
                  className={cn(
                    "flex min-h-[54px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl border text-offwhite transition-colors",
                    on ? "border-gold bg-gold/15 text-gold" : "border-subtle",
                    past && "opacity-30",
                  )}
                >
                  <span className="text-[11px] font-medium">{WEEKDAYS[weekdayOfDateKey(d)]}</span>
                  <span className="text-base font-semibold tabular-nums">{dayOf(d)}</span>
                  <span
                    aria-hidden="true"
                    className={cn("h-1 w-4 rounded-full", saved[d] ? "bg-gold" : "bg-transparent")}
                  />
                </button>
              );
            })}
          </div>
          {picked.length > 0 && (
            <p className="text-xs text-muted">
              {picked.length === 1 ? "1 day picked" : `${picked.length} days picked`}. Move to another week to add
              more.
            </p>
          )}
        </section>

        {offering.length > 1 && (
          <section className="flex flex-col gap-2">
            <h3 className={sectionLabel}>Who</h3>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setWho([])}
                aria-pressed={who.length === 0}
                className={cn(
                  "min-h-[44px] rounded-full border px-3.5 text-sm transition-colors",
                  who.length === 0 ? "border-gold bg-gold/15 text-gold" : "border-subtle text-muted",
                )}
              >
                Everyone who does it
              </button>
              {offering.map((s) => {
                const on = who.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setWho((cur) => (on ? cur.filter((id) => id !== s.id) : [...cur, s.id]))}
                    aria-pressed={on}
                    className={cn(
                      "min-h-[44px] rounded-full border px-3.5 text-sm transition-colors",
                      on ? "border-gold bg-gold/15 text-gold" : "border-subtle text-muted",
                    )}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h3 className={sectionLabel}>{service.name} is open</h3>
          {!closed &&
            rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <TimeSelect
                  value={r.start}
                  onChange={(v) => patchRow(i, { start: v })}
                  className={timeCls}
                  aria-label={`Hours ${i + 1} from`}
                />
                <span className="text-sm text-muted">to</span>
                <TimeSelect
                  value={r.end}
                  onChange={(v) => patchRow(i, { end: v })}
                  className={timeCls}
                  allowMidnightEnd
                  aria-label={`Hours ${i + 1} until`}
                />
                {rows.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setRowsTouched(true);
                      setRows((cur) => cur.filter((_, j) => j !== i));
                    }}
                    aria-label={`Remove hours ${i + 1}`}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:text-danger-soft"
                  >
                    <span aria-hidden="true">{"✕"}</span>
                  </button>
                ) : (
                  <span className="w-11 shrink-0" aria-hidden="true" />
                )}
              </div>
            ))}
          {closed && <p className="text-sm text-muted">Not offered on the days you picked.</p>}
          <FormError>
            {problem === "ends_before_start"
              ? "Each set of hours has to end after it starts."
              : problem === "overlap"
                ? "Two of these overlap. Make one end before the next starts."
                : null}
          </FormError>
          <div className="flex flex-wrap items-end gap-2">
            {!closed && rows.length < MAX_ROWS && (
              <button
                type="button"
                onClick={() => {
                  setRowsTouched(true);
                  setRows((cur) => {
                    const last = cur[cur.length - 1] ?? DEFAULT_ROW;
                    // After the last one, with an hour's gap: the common second
                    // set of hours is "back after a break".
                    const from = Math.min(22 * 60, (hhmmToMinute(last.end) ?? 17 * 60) + 60);
                    const until = Math.min(1440, from + 180);
                    return [...cur, { start: minuteToHhmm(from), end: until === 1440 ? MIDNIGHT_END : minuteToHhmm(until) }];
                  });
                }}
                className="min-h-[44px] rounded-xl border border-dashed border-subtle-strong px-3.5 text-sm font-medium text-gold"
              >
                Add hours
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setNote(null);
                setClosed((c) => !c);
              }}
              aria-pressed={closed}
              className={cn(
                "min-h-[44px] rounded-xl border px-3.5 text-sm font-medium transition-colors",
                closed ? "border-gold bg-gold/15 text-gold" : "border-subtle text-offwhite",
              )}
            >
              {closed ? "Closed those days" : "Closed instead"}
            </button>
          </div>
        </section>

        {!closed && (
          <section className="flex flex-col gap-1.5">
            <MoneyField
              value={price}
              onChange={(v) => {
                setPrice(v);
                setPriceTouched(true);
                setNote(null);
              }}
              label="Price on those days (optional)"
              placeholder={service.price !== null ? String(service.price) : undefined}
              className="max-w-[220px]"
              error={priceBad ? "Enter an amount, or leave it empty." : undefined}
            />
            <p className="text-xs text-muted">Leave it empty to charge the usual price.</p>
          </section>
        )}

        {bars.length > 0 && (
          <section aria-label="What changes" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <h3 className={sectionLabel}>What changes</h3>
              <div className="flex gap-3 text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="h-2 w-3.5 rounded-sm bg-muted/60" />
                  Usual
                </span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="h-2 w-3.5 rounded-sm bg-gold" />
                  Added
                </span>
                {anyRemoved && (
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden="true" className="h-2 w-3.5 rounded-sm border border-dashed border-danger-soft" />
                    Taken away
                  </span>
                )}
              </div>
            </div>
            <div className="rounded-xl border border-subtle px-3 py-2">
              {bars.map((b) => (
                <div key={b.date} className="flex h-8 items-center gap-2.5">
                  <span className="w-[74px] shrink-0 text-xs font-medium text-offwhite">{dateLabel(b.date)}</span>
                  <div
                    role="img"
                    aria-label={`${dateLabel(b.date)}: ${b.delta === "same" ? "same hours as usual" : `${b.delta} against the usual day`}`}
                    className="relative h-3 min-w-0 flex-1 overflow-hidden rounded-full bg-charcoal-700"
                  >
                    {b.kept.map((s, i) => (
                      <span key={`k${i}`} className="absolute inset-y-0 bg-muted/60" style={place(s)} />
                    ))}
                    {b.added.map((s, i) => (
                      <span key={`a${i}`} className="absolute inset-y-0 bg-gold" style={place(s)} />
                    ))}
                    {b.removed.map((s, i) => (
                      <span
                        key={`r${i}`}
                        className="absolute inset-y-0 border border-dashed border-danger-soft"
                        style={place(s)}
                      />
                    ))}
                  </div>
                  <span className="w-[72px] shrink-0 text-right text-xs font-semibold tabular-nums text-gold">
                    {b.delta}
                  </span>
                </div>
              ))}
              <div className="flex justify-between pl-[84px] pr-[82px] pt-0.5 text-[11px] text-muted" aria-hidden="true">
                <span>{hourTick(scale.start)}</span>
                <span>{hourTick(scale.end)}</span>
              </div>
            </div>
          </section>
        )}

        <div className="flex flex-col gap-3 border-t border-subtle pt-4">
          {sentence && !note && (
            <p className="rounded-xl border border-gold/30 bg-gold/10 px-3 py-2.5 text-sm leading-relaxed text-offwhite">
              {sentence} Nobody already booked is moved.
            </p>
          )}
          {note && (
            <p role="status" className="rounded-xl border border-emerald-soft/40 bg-emerald-soft/10 px-3 py-2.5 text-sm leading-relaxed text-offwhite">
              {note}
            </p>
          )}
          <FormError>{error}</FormError>
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[48px] flex-1 rounded-xl border border-subtle text-sm font-medium text-offwhite"
            >
              {note ? "Done" : "Cancel"}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!canSave || busy}
              className="min-h-[48px] flex-[2] rounded-xl bg-gold text-sm font-semibold text-charcoal-900 disabled:opacity-50"
            >
              {busy
                ? "Saving…"
                : sortedPicked.length > 1
                  ? `Save ${sortedPicked.length} days`
                  : sortedPicked.length === 1
                    ? "Save 1 day"
                    : "Pick a day"}
            </button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
