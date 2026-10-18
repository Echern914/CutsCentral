"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type Dispatch, type SetStateAction } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { MinutesField, MoneyField } from "@/components/ui/UnitField";
import { cap, useVocab } from "@/components/VocabProvider";
import { cn } from "@/lib/cn";
import { parsePrice } from "@/lib/serviceFields";
import { zonedDateKey } from "@chairback/config/time";
import {
  listSpecialDaysAction,
  previewSpecialDayAction,
  publishSpecialDayAction,
  removeSpecialDaysAction,
  type SpecialDayInput,
  type SpecialDayPlan,
  type SpecialDayRow,
} from "./actions";
import type { ServiceRow, StaffRow } from "./page";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * SPECIAL DAY - run one date your own way (Drick: "if I want to completely
 * modify how my Thanksgiving day looks instead of working a regular schedule,
 * let's say I want to make all cuts (20 min long) only on that day and charge
 * $65 all day, I need that option").
 *
 * Pick the date, the chairs, the hours, the cut length and the price; the
 * PREVIEW lists every opening before anything is written; Publish creates them
 * (as targeted slots - the booking page shows them with the Special chip) and
 * closes the rest of those chairs' normal schedule that day, all in one server
 * transaction. See apps/api engines/specialDay.ts.
 *
 * Lives right under Holiday pricing because it is the same thought - "this date
 * is different" - taken past price to the whole day's times.
 */

const field =
  "rounded-lg border border-subtle bg-charcoal-700 px-2 py-1.5 text-xs text-offwhite";

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

function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `sd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

const SKIP_WORDS: Record<SpecialDayPlan["skipped"][number]["reason"], string> = {
  booking: "already booked",
  blocked: "blocked time",
  past: "already passed",
};

export function SpecialDayCard({
  services,
  staff,
  timezone,
  toast,
  onChanged,
}: {
  services: ServiceRow[];
  staff: StaffRow[];
  timezone: string;
  toast: Toast;
  /** A special day was published or removed (the Targeted slots list re-reads). */
  onChanged?: () => void;
}) {
  const vocab = useVocab();
  const activeServices = useMemo(() => services.filter((s) => s.active), [services]);
  const activeStaff = useMemo(() => staff.filter((s) => s.active), [staff]);
  const today = zonedDateKey(new Date(), timezone);
  const time = useMemo(
    () => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: timezone }),
    [timezone],
  );
  const staffName = (id: string) => activeStaff.find((s) => s.id === id)?.name ?? staff.find((s) => s.id === id)?.name ?? "?";

  // The list of upcoming special days. null = still loading.
  const [rows, setRows] = useState<SpecialDayRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, start] = useTransition();

  // The builder.
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [chairs, setChairs] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("17:00");
  const [cut, setCut] = useState("20");
  const [price, setPrice] = useState("");
  const [counts, setCounts] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<{ plans: SpecialDayPlan[]; bufferMin: number; input: SpecialDayInput } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // One id per previewed day: a retried or double-tapped Publish replays the
  // first answer on the server instead of publishing twice.
  const requestId = useRef<string>(newRequestId());

  function load() {
    start(async () => {
      const r = await listSpecialDaysAction();
      if (r.ok && r.specialDays) {
        setRows(r.specialDays);
        setLoadFailed(false);
      } else setLoadFailed(true);
    });
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Anything changed after a preview makes it stale: the barber must see the
  // openings he is publishing, so the preview (and its request id) go.
  function changed<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v);
      setPreview(null);
      setProblem(null);
    };
  }
  function toggle(set: Dispatch<SetStateAction<Set<string>>>, id: string) {
    set((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPreview(null);
    setProblem(null);
  }

  function reset() {
    setOpen(false);
    setName("");
    setDate("");
    setChairs(new Set());
    setFrom("09:00");
    setTo("17:00");
    setCut("20");
    setPrice("");
    setCounts(new Set());
    setPreview(null);
    setProblem(null);
    requestId.current = newRequestId();
  }

  /** The form as a request, or the reason it isn't one yet. */
  function readForm(): SpecialDayInput | string {
    if (!date) return "Pick the date";
    if (chairs.size === 0) return `Pick at least one ${vocab.providerNoun}`;
    if (!from || !to || to <= from) return "The end time must be after the start time";
    const cutMin = Number(cut);
    if (!Number.isInteger(cutMin) || cutMin < 5 || cutMin > 240) return "Length is 5 to 240 minutes";
    const p = parsePrice(price);
    if (!p.ok) return p.error;
    if (p.value === null) return "Set the price for each opening";
    if (counts.size === 0) return "Choose which services the openings count as";
    return {
      date,
      staffIds: [...chairs],
      start: from,
      end: to,
      cutMin,
      price: p.value,
      serviceIds: [...counts],
      ...(name.trim() ? { name: name.trim() } : {}),
    };
  }

  function runPreview() {
    const input = readForm();
    if (typeof input === "string") {
      setProblem(input);
      return;
    }
    setProblem(null);
    start(async () => {
      const r = await previewSpecialDayAction(input);
      if (r.ok) {
        requestId.current = newRequestId();
        setPreview({ plans: r.plans, bufferMin: r.bufferMin, input });
      } else setProblem(r.message ?? "Couldn't build the preview. Try again.");
    });
  }

  const total = preview ? preview.plans.reduce((n, p) => n + p.openings.length, 0) : 0;

  function publish() {
    if (!preview || pending) return;
    const input: SpecialDayInput = {
      ...preview.input,
      requestId: requestId.current,
      expectOpenings: total,
    };
    start(async () => {
      const r = await publishSpecialDayAction(input);
      if (r.ok) {
        toast(
          `${input.name ?? "Special day"} published: ${total} opening${total === 1 ? "" : "s"} on ${prettyDate(input.date)}`,
          "success",
        );
        reset();
        load();
        onChanged?.();
        return;
      }
      // The calendar moved since the preview: show the new one, publish nothing.
      if (r.error === "changed" && r.plans) {
        setPreview({ ...preview, plans: r.plans });
        requestId.current = newRequestId();
      }
      setProblem(r.message ?? "Couldn't publish. Nothing was changed - try again.");
    });
  }

  /** Every chair's special day on one date goes together. */
  function remove(group: SpecialDayRow[]) {
    const first = group[0]!;
    const label = first.name ?? prettyDate(first.date);
    const booked = group.reduce((n, r) => n + r.booked, 0);
    const question =
      `Remove ${label} on ${prettyDate(first.date)}? Its open times are deleted and the normal schedule comes back.` +
      (booked > 0 ? ` ${booked} booked visit${booked === 1 ? "" : "s"} stay booked.` : "");
    if (!window.confirm(question)) return;
    start(async () => {
      const r = await removeSpecialDaysAction(group.map((g) => g.ruleId));
      if (r.ok) {
        toast(
          `${label} removed` +
            (r.bookedKept > 0 ? ` - ${r.bookedKept} booked visit${r.bookedKept === 1 ? "" : "s"} kept` : ""),
          "success",
        );
        load();
        onChanged?.();
      } else toast("Couldn't remove it - nothing was changed", "error");
    });
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
        subtitle={`Run one date your own way: your hours, one length, one price. Only those openings can be booked that day - the normal schedule is closed for the ${vocab.providerNounPlural} you pick.`}
      />

      {rows === null && !loadFailed ? (
        <p className="mt-3 text-sm text-muted">Loading…</p>
      ) : loadFailed ? (
        <p className="mt-3 text-sm text-muted">
          Couldn&apos;t load your special days.{" "}
          <button type="button" onClick={load} className="text-gold underline">
            Try again
          </button>
        </p>
      ) : groups.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          None planned. Thanksgiving with 20-minute openings at $65 from 9 to 5, a
          late-opening Saturday - set it up once and preview every opening before
          it goes live.
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
                      {r.openings} opening{r.openings === 1 ? "" : "s"} · {r.cutMin} min · $
                      {r.price.toFixed(0)}
                      {r.booked > 0 ? ` · ${r.booked} booked` : ""}
                    </p>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => remove(group)}
                  disabled={pending}
                  className="rounded px-1.5 py-1 text-xs text-muted transition-colors hover:text-danger-soft disabled:opacity-50"
                  aria-label={`Remove special day on ${prettyDate(first.date)}`}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!open ? (
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(true);
            // One chair: nothing to choose.
            if (activeStaff.length === 1) setChairs(new Set([activeStaff[0]!.id]));
          }}
          disabled={activeStaff.length === 0 || activeServices.length === 0}
          className="mt-4 rounded-lg bg-gold/15 px-3 py-1.5 text-xs font-medium text-gold transition-colors hover:bg-gold/25 disabled:opacity-50"
        >
          + Plan a special day
        </button>
      ) : (
        <div className="mt-4 rounded-xl border border-gold/40 bg-gold/5 p-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[11px] text-muted">
              Name (optional)
              <input
                type="text"
                value={name}
                maxLength={40}
                placeholder="Thanksgiving"
                onChange={(e) => changed(setName)(e.target.value)}
                className={cn(field, "w-44")}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted">
              Date
              <input
                type="date"
                min={today}
                value={date}
                onChange={(e) => changed(setDate)(e.target.value)}
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted">
              From
              <input type="time" value={from} onChange={(e) => changed(setFrom)(e.target.value)} className={field} />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted">
              To
              <input type="time" value={to} onChange={(e) => changed(setTo)(e.target.value)} className={field} />
            </label>
            <MinutesField
              label="Length"
              value={cut}
              onChange={changed(setCut)}
              min={5}
              placeholder="20"
              className="w-28"
              inputClassName="rounded-lg py-1.5 text-xs"
            />
            <MoneyField
              label="Price each"
              value={price}
              onChange={changed(setPrice)}
              placeholder="65"
              className="w-28"
              inputClassName="rounded-lg py-1.5 text-xs"
            />
          </div>

          <p className="mt-3 text-[11px] text-muted">{cap(vocab.providerNounPlural)}</p>
          <div role="group" aria-label={cap(vocab.providerNounPlural)} className="mt-1 flex flex-wrap gap-1.5">
            {activeStaff.map((s) => {
              const on = chairs.has(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(setChairs, s.id)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                    on ? "border-gold/60 bg-gold/15 text-gold" : "border-subtle text-muted hover:text-offwhite",
                  )}
                >
                  {s.name}
                </button>
              );
            })}
          </div>

          <p className="mt-3 text-[11px] text-muted">Openings count as</p>
          <div role="group" aria-label="Services the openings count as" className="mt-1 flex flex-wrap gap-1.5">
            {activeServices.map((s) => {
              const on = counts.has(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(setCounts, s.id)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                    on ? "border-gold/60 bg-gold/15 text-gold" : "border-subtle text-muted hover:text-offwhite",
                  )}
                >
                  {s.name}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              setCounts((cur) =>
                cur.size === activeServices.length ? new Set() : new Set(activeServices.map((s) => s.id)),
              );
              setPreview(null);
            }}
            className="mt-2 text-[11px] text-muted underline transition-colors hover:text-gold"
          >
            {counts.size === activeServices.length ? "Clear all" : "Select every service"}
          </button>

          {preview && (
            <div className="mt-3 rounded-lg border border-subtle p-3" aria-live="polite">
              <p className="text-sm font-medium text-offwhite">
                {total} opening{total === 1 ? "" : "s"} at ${preview.input.price.toFixed(0)}
                {preview.input.name ? ` · ${preview.input.name}` : ""} · {prettyDate(preview.input.date)}
              </p>
              {preview.bufferMin > 0 && (
                <p className="mt-0.5 text-[11px] text-muted">
                  Spaced {preview.input.cutMin + preview.bufferMin} minutes apart: the {preview.input.cutMin}-min cut
                  plus your {preview.bufferMin}-min turnover.
                </p>
              )}
              {preview.plans.map((p) => (
                <div key={p.staffId} className="mt-2">
                  <p className="text-xs font-medium text-offwhite">
                    {staffName(p.staffId)} - {p.openings.length} opening{p.openings.length === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-muted">
                    {p.openings.length > 0
                      ? p.openings.map((o) => time.format(new Date(o))).join(", ")
                      : "No openings fit around what is already on this calendar."}
                  </p>
                  {p.skipped.length > 0 && (
                    <p className="mt-0.5 text-[11px] text-gold">
                      Left out: {p.skipped.map((s) => `${time.format(new Date(s.startsAt))} (${SKIP_WORDS[s.reason]})`).join(", ")}
                    </p>
                  )}
                  {p.bookings.length > 0 && (
                    <p className="mt-0.5 text-[11px] text-muted">
                      {p.bookings.length} booking{p.bookings.length === 1 ? " is" : "s are"} already on this day (
                      {p.bookings.map((b) => time.format(new Date(b.startsAt))).join(", ")}). They stay booked - nothing
                      is moved or cancelled.
                    </p>
                  )}
                </div>
              ))}
              <p className="mt-2 text-[11px] text-muted">
                Publishing closes the rest of the normal schedule that day for these {vocab.providerNoun}s, so only
                these openings can be booked.
              </p>
            </div>
          )}

          {problem && (
            <p role="alert" className="mt-3 text-xs text-danger-soft">
              {problem}
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {preview && total > 0 ? (
              <button
                type="button"
                onClick={publish}
                disabled={pending}
                className="rounded-lg bg-gold/20 px-3 py-1.5 text-xs font-semibold text-gold transition-colors hover:bg-gold/30 disabled:opacity-50"
              >
                {pending ? "Publishing…" : `Publish ${total} opening${total === 1 ? "" : "s"}`}
              </button>
            ) : (
              <button
                type="button"
                onClick={runPreview}
                disabled={pending}
                className="rounded-lg bg-gold/20 px-3 py-1.5 text-xs font-semibold text-gold transition-colors hover:bg-gold/30 disabled:opacity-50"
              >
                {pending ? "Checking…" : "Preview openings"}
              </button>
            )}
            <button
              type="button"
              onClick={reset}
              className="rounded px-2 py-1.5 text-xs text-muted transition-colors hover:text-offwhite"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
