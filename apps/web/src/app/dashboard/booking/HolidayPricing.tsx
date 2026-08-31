"use client";

import { useMemo, useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { MoneyField } from "@/components/ui/UnitField";
import { parsePrice } from "@/lib/serviceFields";
import { collapseRuns, expandRange, MAX_RANGE_DAYS } from "@/lib/dateRanges";
import { updateServiceAction } from "./actions";
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
 * to know this screen exists.
 */

/** A date with everything priced on it, assembled back out of the services. */
interface HolidayGroup {
  date: string; // YYYY-MM-DD
  entries: { serviceId: string; serviceName: string; price: number }[];
}

/** Shop-local "today" is close enough to dim a date that has already passed. */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
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
  toast,
}: {
  services: ServiceRow[];
  toast: Toast;
}) {
  // No refresh callback: updateServiceAction revalidates /dashboard/booking, so
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
  const [picked, setPicked] = useState<Set<string>>(new Set());

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
    const signature = (g: HolidayGroup) =>
      JSON.stringify(
        [...g.entries]
          .map((e) => [e.serviceId, e.price] as const)
          .sort((a, b) => a[0].localeCompare(b[0])),
      );
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
  }, [groups]);

  const today = todayKey();

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
    setDate("");
    setDateTo("");
    setDates([]);
    setPrice("");
    setPicked(new Set());
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
      // dateOverrides is a per-service blob, so a shop-wide holiday is N
      // writes - ONE per service, whatever the date count: all the chosen
      // dates merge into each service's existing blob together, so another
      // holiday already on the service survives, and a two-date save cannot
      // half-land on a service.
      const results = await Promise.all(
        [...picked].map((id) => {
          const svc = services.find((s) => s.id === id);
          const merged = { ...(svc?.dateOverrides ?? {}) };
          for (const d of chosen) merged[d] = value;
          return updateServiceAction(id, { dateOverrides: merged });
        }),
      );
      const failed = results.filter((r) => !r.ok).length;
      if (failed === 0) {
        toast(
          `${
            chosen.length === 1
              ? prettyDate(chosen[0]!)
              : `${chosen.length} dates`
          } priced on ${picked.size} service${picked.size === 1 ? "" : "s"}`,
          "success",
        );
        reset();
      } else {
        // Partial success is real (N independent writes), so refresh either way
        // rather than leaving the list showing a state that no longer matches.
        toast(`Couldn't set ${failed} of ${results.length}`, "error");
      }
    });
  }

  /** Remove a whole displayed stretch: every date of the run, per service. */
  function clearDates(datesToClear: string[], entries: HolidayGroup["entries"]) {
    start(async () => {
      const serviceIds = [...new Set(entries.map((e) => e.serviceId))];
      const results = await Promise.all(
        serviceIds.map((id) => {
          const svc = services.find((s) => s.id === id);
          const rest = { ...(svc?.dateOverrides ?? {}) };
          for (const d of datesToClear) delete rest[d];
          return updateServiceAction(id, { dateOverrides: rest });
        }),
      );
      if (results.every((r) => r.ok)) toast("Holiday removed", "success");
      else toast("Couldn't remove all of it", "error");
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
                    {label}
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
                <button
                  type="button"
                  onClick={() => clearDates(run.dates, run.group.entries)}
                  disabled={pending}
                  className="rounded px-1.5 py-1 text-xs text-muted transition-colors hover:text-danger-soft disabled:opacity-50"
                  aria-label={`Remove holiday pricing on ${label}`}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!adding ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={active.length === 0}
          className="mt-4 rounded-lg bg-gold/15 px-3 py-1.5 text-xs font-medium text-gold transition-colors hover:bg-gold/25 disabled:opacity-50"
        >
          + Add a holiday
        </button>
      ) : (
        <div className="mt-4 rounded-xl border border-gold/40 bg-gold/5 p-3">
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
              {pending ? "Saving…" : "Save holiday"}
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
