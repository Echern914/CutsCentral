"use client";

import { useMemo, useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { MoneyField } from "@/components/ui/UnitField";
import { parsePrice } from "@/lib/serviceFields";
import { zonedDateKey } from "@chairback/config/time";
import { collapseRuns, expandRange, MAX_RANGE_DAYS } from "@/lib/dateRanges";
import { saveHolidayAction } from "./actions";
import type { ServiceRow } from "./page";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * Holiday pricing, from the SHOP's point of view.
 *
 * The per-service editor has always been able to do this (a named date beats
 * every other pricing layer — see engines/pricing.ts), but it asks the question
 * backwards: open Skin Fade, expand a panel, add Christmas Eve; then open Beard
 * Trim and do it again. A barber does not think "for each service, set
 * Christmas Eve" — he thinks "Christmas Eve everything is dearer". Nothing
 * showed him which dates were already priced either, so a holiday set on two of
 * five services looked exactly like one set on all five.
 *
 * This is the same storage read the other way round: every date any service
 * prices, grouped, with its services underneath — plus one control that prices
 * a date across several services at once.
 *
 * NO NEW MODEL. Each save still writes `dateOverrides` on the services it
 * names, so the pricing engine, the public menu and the booking flow never need
 * to know this screen exists. The one addition is a NAME per date
 * (Shop.holidayNames - Drick: "need to be able to edit the holiday and name
 * it"), and every save - add, edit, remove - is ONE server transaction
 * (PUT /api/booking/holidays), so an edit can never leave half the services on
 * the old date and half on the new.
 */

/** A date with everything priced on it, assembled back out of the services. */
interface HolidayGroup {
  date: string; // YYYY-MM-DD
  entries: { serviceId: string; serviceName: string; price: number }[];
}

/**
 * The SHOP's date. Not the UTC date: in a US evening that is already tomorrow,
 * so today could not be picked and today's holiday showed as passed.
 */
function todayKey(timezone?: string): string {
  return zonedDateKey(new Date(), timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/** "2026-12-24" -> "Thu, Dec 24, 2026". Noon avoids a DST off-by-one. */
function prettyDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function HolidayPricing({
  services,
  names = {},
  timezone,
  toast,
}: {
  services: ServiceRow[];
  /** The shop's names for its dates ({"2026-11-26": "Thanksgiving"}). */
  names?: Record<string, string>;
  /** The shop's IANA zone, which decides what "today" is. */
  timezone?: string;
  toast: Toast;
}) {
  // No refresh callback: saveHolidayAction revalidates /dashboard/booking, so
  // the server re-renders and hands this component fresh `services` - the same
  // way every other card on this tab stays current.
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  // SEVERAL dates share one price rule (Drick: "we still need multiple date
  // selection"; Eric: "it should be from a day to a day ... december 25-31").
  // The picker is a from/to pair - leave "to" blank for a single day - and
  // "+ Add" stages the whole INCLUSIVE stretch into `dates`; save prices
  // EVERY staged date on every picked service. Contiguous stretches render
  // and remove as ONE chip (collapseRuns), so a priced week reads as a week.
  const [date, setDate] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dates, setDates] = useState<string[]>([]);
  const [price, setPrice] = useState("");
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // The saved stretch being edited (its dates), or null when adding. Save
  // takes these dates off every service and writes the form's in one go.
  const [editing, setEditing] = useState<string[] | null>(null);

  const active = useMemo(() => services.filter((s) => s.active), [services]);

  // Every priced date across every service, soonest first. Built from the same
  // dateOverrides the per-service editor writes, so the two cannot disagree.
  const groups = useMemo<HolidayGroup[]>(() => {
    const byDate = new Map<string, HolidayGroup["entries"]>();
    for (const s of services) {
      for (const [d, p] of Object.entries(s.dateOverrides ?? {})) {
        byDate.set(d, [
          ...(byDate.get(d) ?? []),
          { serviceId: s.id, serviceName: s.name, price: Number(p) },
        ]);
      }
    }
    return [...byDate.entries()]
      .map(([d, entries]) => ({ date: d, entries }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [services]);

  // Saved dates collapse the same way the staged chips do: contiguous days
  // priced IDENTICALLY (same services at the same prices) render as one
  // "Dec 25 – 31" row, and Remove clears the whole stretch. Days that differ
  // stay separate rows - collapsing them would hide a real difference.
  const displayGroups = useMemo(() => {
    // The NAME is part of the signature: Dec 24 "Christmas Eve" and Dec 25
    // "Christmas" priced alike are still two holidays.
    const signature = (g: HolidayGroup) =>
      JSON.stringify([
        names[g.date] ?? "",
        [...g.entries]
          .map((e) => [e.serviceId, e.price] as const)
          .sort((a, b) => a[0].localeCompare(b[0])),
      ]);
    const byDate = new Map(groups.map((g) => [g.date, g]));
    const out: { from: string; to: string; dates: string[]; group: HolidayGroup }[] = [];
    for (const run of collapseRuns(groups.map((g) => g.date))) {
      let days = expandRange(run.from, run.to) ?? [run.from];
      // Split a contiguous stretch wherever the pricing changes mid-run.
      while (days.length > 0) {
        const first = byDate.get(days[0]!)!;
        const sig = signature(first);
        let n = 1;
        while (n < days.length && signature(byDate.get(days[n]!)!) === sig) n++;
        out.push({
          from: days[0]!,
          to: days[n - 1]!,
          dates: days.slice(0, n),
          group: first,
        });
        days = days.slice(n);
      }
    }
    return out;
  }, [groups, names]);

  const today = todayKey(timezone);

  function toggle(id: string) {
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function reset() {
    setAdding(false);
    setEditing(null);
    setDate("");
    setDateTo("");
    setDates([]);
    setPrice("");
    setName("");
    setPicked(new Set());
  }

  /** Open the form on a saved stretch: its dates, price, services and name. */
  function beginEdit(run: { dates: string[]; group: HolidayGroup }) {
    const prices = [...new Set(run.group.entries.map((e) => e.price))];
    setEditing(run.dates);
    setAdding(true);
    setDate("");
    setDateTo("");
    setDates(run.dates);
    // One price box: prefilled when every service shares it. Mixed prices
    // (set one service at a time in the service editor) leave it blank so a
    // save cannot silently flatten them to one number.
    setPrice(prices.length === 1 ? String(prices[0]) : "");
    setName(names[run.dates[0]!] ?? "");
    setPicked(new Set(run.group.entries.map((e) => e.serviceId)));
  }

  /**
   * What the from/to pair currently describes: one day, an inclusive range,
   * or null when the pair is invalid (backwards, or absurdly long) - the
   * caller says WHY with a toast rather than silently pricing something else.
   */
  function pickerDates(): string[] | null {
    if (!date) return [];
    if (!dateTo) return [date];
    return expandRange(date, dateTo);
  }

  /** The staged chips plus whatever the picker currently holds. */
  function allDates(): string[] | null {
    const fromPicker = pickerDates();
    if (fromPicker === null) return null;
    return [...new Set([...dates, ...fromPicker])].sort();
  }

  function stageDate() {
    const fromPicker = pickerDates();
    if (fromPicker === null) {
      toast(
        `That range doesn't work — "to" must be on or after the first date, within ${MAX_RANGE_DAYS} days`,
        "error",
      );
      return;
    }
    if (fromPicker.length === 0) return;
    setDates((cur) => [...new Set([...cur, ...fromPicker])].sort());
    setDate("");
    setDateTo("");
  }

  function save() {
    const chosen = allDates();
    if (chosen === null) {
      toast(
        `That range doesn't work — "to" must be on or after the first date, within ${MAX_RANGE_DAYS} days`,
        "error",
      );
      return;
    }
    if (chosen.length === 0) {
      toast("Pick a date", "error");
      return;
    }
    // Same parser as every other price box in the app, so "$75" pasted off a
    // price list works here too and a negative is refused with the same words.
    const parsed = parsePrice(price);
    if (!parsed.ok) {
      toast(parsed.error, "error");
      return;
    }
    if (parsed.value === null) {
      // Blank is "inherit" on an override field, but a holiday IS the override
      // - there is nothing to inherit, so it has to be a number.
      toast("Set the price for that day", "error");
      return;
    }
    const value = parsed.value;
    if (picked.size === 0) {
      toast("Choose at least one service", "error");
      return;
    }
    start(async () => {
      // ONE call, one transaction: the old dates (when editing) come off every
      // service, the chosen dates go on the picked ones, and the name is set -
      // or none of it happens.
      const r = await saveHolidayAction({
        removeDates: editing ?? [],
        dates: chosen,
        price: value,
        serviceIds: [...picked],
        name: name.trim(),
      });
      if (r.ok) {
        const what = name.trim() || (chosen.length === 1 ? prettyDate(chosen[0]!) : `${chosen.length} dates`);
        toast(
          `${what} ${editing ? "updated" : `priced on ${picked.size} service${picked.size === 1 ? "" : "s"}`}`,
          "success",
        );
        reset();
      } else {
        toast(
          r.error === "too_many_dates"
            ? "A service can hold 120 holiday dates at most - remove some passed ones first"
            : "Couldn't save the holiday - nothing was changed",
          "error",
        );
      }
    });
  }

  /** Remove a whole displayed stretch: every date of the run, every service. */
  function clearDates(datesToClear: string[], label: string) {
    if (!window.confirm(`Remove the holiday on ${label}? Those days go back to normal prices.`)) return;
    start(async () => {
      const r = await saveHolidayAction({ removeDates: datesToClear });
      if (r.ok) {
        toast("Holiday removed", "success");
        if (editing && editing.some((d) => datesToClear.includes(d))) reset();
      } else toast("Couldn't remove it - nothing was changed", "error");
    });
  }

  return (
    <Card className="p-5">
      <CardHeader
        title="Holiday pricing"
        subtitle="Charge a different price on a named date. A holiday beats every other price rule you've set."
      />

      {groups.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          Nothing priced yet. Christmas Eve, the day before prom, the Saturday of
          a holiday weekend — set the date once here and pick which services it
          applies to.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-subtle overflow-hidden rounded-xl border border-subtle">
          {displayGroups.map((run) => {
            const past = run.to < today;
            const label =
              run.from === run.to
                ? prettyDate(run.from)
                : `${prettyDate(run.from)} – ${prettyDate(run.to)}`;
            const holidayName = names[run.from];
            return (
              <li
                key={run.from}
                className={cn(
                  "flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-3 py-2.5",
                  past && "opacity-50",
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-offwhite">
                    {holidayName ? (
                      <>
                        {holidayName}
                        <span className="ml-2 text-xs font-normal text-muted">{label}</span>
                      </>
                    ) : (
                      label
                    )}
                    {past && (
                      <span className="ml-2 text-[11px] font-normal text-muted">
                        passed
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted">
                    {run.group.entries
                      .map((e) => `${e.serviceName} $${e.price.toFixed(0)}`)
                      .join(" · ")}
                  </p>
                </div>
                <span className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => beginEdit(run)}
                    disabled={pending}
                    className="rounded px-1.5 py-1 text-xs text-gold transition-colors hover:underline disabled:opacity-50"
                    aria-label={`Edit holiday on ${label}`}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => clearDates(run.dates, holidayName ?? label)}
                    disabled={pending}
                    className="rounded px-1.5 py-1 text-xs text-muted transition-colors hover:text-danger-soft disabled:opacity-50"
                    aria-label={`Remove holiday pricing on ${label}`}
                  >
                    Remove
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {!adding ? (
        <button
          type="button"
          onClick={() => {
            reset();
            setAdding(true);
          }}
          disabled={active.length === 0}
          className="mt-4 rounded-lg bg-gold/15 px-3 py-1.5 text-xs font-medium text-gold transition-colors hover:bg-gold/25 disabled:opacity-50"
        >
          + Add a holiday
        </button>
      ) : (
        <div className="mt-4 rounded-xl border border-gold/40 bg-gold/5 p-3">
          {editing && (
            <p className="mb-2 text-xs font-medium text-gold">
              Editing {names[editing[0]!] ?? prettyDate(editing[0]!)} - saving replaces it
            </p>
          )}
          <label className="mb-3 flex flex-col gap-1 text-[11px] text-muted">
            Name (optional)
            <input
              type="text"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              placeholder="Thanksgiving"
              className="w-full max-w-xs rounded-lg border border-subtle bg-charcoal-700 px-2 py-1.5 text-xs text-offwhite"
            />
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[11px] text-muted">
              Dates (leave “to” blank for one day)
              <span className="flex flex-wrap items-center gap-1.5">
                <input
                  type="date"
                  min={today}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  aria-label="First day"
                  className="rounded-lg border border-subtle bg-charcoal-700 px-2 py-1.5 text-xs text-offwhite"
                />
                <span className="px-0.5 text-muted">–</span>
                <input
                  type="date"
                  min={date || today}
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  aria-label="Last day (optional)"
                  className="rounded-lg border border-subtle bg-charcoal-700 px-2 py-1.5 text-xs text-offwhite"
                />
                {/* Staging is optional: Save prices the picker's dates too, so
                    the one-shot flow is still pick → save, no extra tap. */}
                <button
                  type="button"
                  onClick={stageDate}
                  disabled={!date}
                  className="rounded-lg border border-subtle px-2 py-1.5 text-xs text-muted transition-colors hover:border-gold/50 hover:text-gold disabled:opacity-40"
                >
                  + Add dates
                </button>
              </span>
            </label>
            <MoneyField
              label="Price those days"
              value={price}
              onChange={setPrice}
              placeholder="75"
              className="w-32"
              inputClassName="rounded-lg py-1.5 text-xs"
            />
          </div>
          {dates.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {/* Contiguous days render as ONE chip - a staged Dec 25-31 is a
                  week, not seven pills - and ✕ removes the whole stretch. */}
              {collapseRuns(dates).map((run) => {
                const runDays = expandRange(run.from, run.to) ?? [run.from];
                const text =
                  run.from === run.to
                    ? prettyDate(run.from)
                    : `${prettyDate(run.from)} – ${prettyDate(run.to)}`;
                return (
                  <span
                    key={run.from}
                    className="inline-flex items-center gap-1 rounded-full border border-gold/40 bg-gold/10 px-2 py-0.5 text-[11px] text-gold"
                  >
                    {text}
                    <button
                      type="button"
                      onClick={() =>
                        setDates((cur) => cur.filter((x) => !runDays.includes(x)))
                      }
                      className="rounded px-0.5 text-muted transition-colors hover:text-danger-soft"
                      aria-label={`Remove ${text}`}
                    >
                      ✕
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          <p className="mt-3 text-[11px] text-muted">Applies to</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {active.map((s) => {
              const on = picked.has(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggle(s.id)}
                  aria-pressed={on}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                    on
                      ? "border-gold/60 bg-gold/15 text-gold"
                      : "border-subtle text-muted hover:text-offwhite",
                  )}
                >
                  {s.name}
                  {s.price !== null && (
                    <span className="ml-1 opacity-60">
                      ${Number(s.price).toFixed(0)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {/* One tap for the common "the whole day is dearer" case. */}
          <button
            type="button"
            onClick={() =>
              setPicked((cur) =>
                cur.size === active.length
                  ? new Set()
                  : new Set(active.map((s) => s.id)),
              )
            }
            className="mt-2 text-[11px] text-muted underline transition-colors hover:text-gold"
          >
            {picked.size === active.length ? "Clear all" : "Select every service"}
          </button>

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className="rounded-lg bg-gold/20 px-3 py-1.5 text-xs font-semibold text-gold transition-colors hover:bg-gold/30 disabled:opacity-50"
            >
              {pending ? "Saving…" : editing ? "Save changes" : "Save holiday"}
            </button>
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
