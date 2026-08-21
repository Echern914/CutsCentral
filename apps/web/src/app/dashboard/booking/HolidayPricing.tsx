"use client";

import { useMemo, useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { MoneyField } from "@/components/ui/UnitField";
import { parsePrice } from "@/lib/serviceFields";
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
  const [date, setDate] = useState("");
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
    setPrice("");
    setPicked(new Set());
  }

  function save() {
    if (!date) {
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
      // writes. MERGE into what each service already has rather than replacing
      // it — another holiday on the same service has to survive this save.
      const results = await Promise.all(
        [...picked].map((id) => {
          const svc = services.find((s) => s.id === id);
          const merged = { ...(svc?.dateOverrides ?? {}), [date]: value };
          return updateServiceAction(id, { dateOverrides: merged });
        }),
      );
      const failed = results.filter((r) => !r.ok).length;
      if (failed === 0) {
        toast(
          `${prettyDate(date)} priced on ${picked.size} service${picked.size === 1 ? "" : "s"}`,
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

  function clearDate(group: HolidayGroup) {
    start(async () => {
      const results = await Promise.all(
        group.entries.map((e) => {
          const svc = services.find((s) => s.id === e.serviceId);
          const rest = { ...(svc?.dateOverrides ?? {}) };
          delete rest[group.date];
          return updateServiceAction(e.serviceId, { dateOverrides: rest });
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
          {groups.map((g) => {
            const past = g.date < today;
            return (
              <li
                key={g.date}
                className={cn(
                  "flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-3 py-2.5",
                  past && "opacity-50",
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-offwhite">
                    {prettyDate(g.date)}
                    {past && (
                      <span className="ml-2 text-[11px] font-normal text-muted">
                        passed
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted">
                    {g.entries
                      .map((e) => `${e.serviceName} $${e.price.toFixed(0)}`)
                      .join(" · ")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => clearDate(g)}
                  disabled={pending}
                  className="rounded px-1.5 py-1 text-xs text-muted transition-colors hover:text-danger-soft disabled:opacity-50"
                  aria-label={`Remove holiday pricing on ${prettyDate(g.date)}`}
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
              Date
              <input
                type="date"
                min={today}
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="rounded-lg border border-subtle bg-charcoal-700 px-2 py-1.5 text-xs text-offwhite"
              />
            </label>
            <MoneyField
              label="Price that day"
              value={price}
              onChange={setPrice}
              placeholder="75"
              className="w-32"
              inputClassName="rounded-lg py-1.5 text-xs"
            />
          </div>

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
