"use client";

import { useState, type ReactNode } from "react";
import { dateLabel, weekdayOfDateKey } from "@chairback/config/dateHoursPlan";
import { Card, CardHeader } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import type { ServiceRow } from "./page";
import { KIND_LABEL, type SpecialDateEntry, type SpecialDateKind, type SpecialDateMonth } from "./specialDateRows";

/**
 * THE SPECIAL DATES LIST - every day that runs differently, soonest first.
 *
 * This is the top of the Special dates section. It only shows and routes:
 * a row opens the tool that owns that change, and "Add a date" asks which
 * kind of change it is and opens the same tool ready to add. What each row
 * says is decided in specialDateRows.ts.
 */

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Theme tokens only: a raw tailwind colour does not flip with the theme. */
const CHIP: Record<SpecialDateKind, string> = {
  opening: "bg-emerald-soft/15 text-emerald-soft",
  hours: "bg-gold/15 text-gold",
  closed: "bg-charcoal-700 text-muted",
  price: "bg-indigo-soft/15 text-indigo-soft",
  day: "bg-info-soft/15 text-info-soft",
};

/** The four ways a date can differ, in the words a barber would use. */
export type AddKind = "price" | "hours" | "day" | "opening";

const ADD_CHOICES: { kind: AddKind; label: string; hint: string }[] = [
  {
    kind: "price",
    label: "A different price",
    hint: "A holiday rate on one day or a stretch of days, for the services you pick.",
  },
  {
    kind: "hours",
    label: "Different hours for one service",
    hint: "Longer, shorter or closed. Everything else keeps its usual day.",
  },
  {
    kind: "day",
    label: "The whole day, run your way",
    hint: "Your own openings, lengths and prices. The usual schedule is closed that day.",
  },
  {
    kind: "opening",
    label: "One extra opening",
    hint: "A single time at its own price, like a late-night slot.",
  },
];

function Chevron() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-muted"
    >
      <path d="M6 3l5 5-5 5" />
    </svg>
  );
}

/**
 * A tool as its own card - or, inside a row that already says its name, just
 * its one line of explanation. The three tools under the list are drawn both
 * ways: as rows here, as cards where they are used alone.
 */
export function ToolShell({
  embedded,
  title,
  subtitle,
  children,
}: {
  embedded: boolean;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  if (embedded) {
    return (
      <div>
        <p className="text-xs text-muted">{subtitle}</p>
        {children}
      </div>
    );
  }
  return (
    <Card className="p-5">
      <CardHeader title={title} subtitle={subtitle} />
      {children}
    </Card>
  );
}

export function SpecialDatesList({
  months,
  services,
  loading = false,
  missing = [],
  onShowMissing,
  onOpen,
  onAdd,
}: {
  months: SpecialDateMonth[];
  /** Offered when the change is one service's hours. */
  services: Pick<ServiceRow, "id" | "name" | "active">[];
  /** Special days or openings are still being read. */
  loading?: boolean;
  /**
   * What could not be read ("special days", "one-time openings"), so the
   * list may be missing rows. The way out - try again, or reload after an
   * update - belongs to the tool whose read failed, so this only leads there.
   */
  missing?: string[];
  onShowMissing?: () => void;
  onOpen: (entry: SpecialDateEntry) => void;
  onAdd: (kind: AddKind, serviceId?: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [pickService, setPickService] = useState(false);
  const active = services.filter((s) => s.active);
  const count = months.reduce((n, m) => n + m.entries.length, 0);
  const failed = missing.length > 0;

  function close() {
    setAdding(false);
    setPickService(false);
  }

  function choose(kind: AddKind) {
    if (kind === "hours") {
      // One service: there is nothing to pick.
      if (active.length === 1) {
        close();
        onAdd("hours", active[0]!.id);
      } else setPickService(true);
      return;
    }
    close();
    onAdd(kind);
  }

  return (
    <Card id="special-dates-list" className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 basis-56 text-sm text-muted">
          Every day that runs differently from your usual week: its own price, its own hours, or a
          one-time opening.
        </p>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="min-h-[44px] shrink-0 rounded-xl bg-gold px-4 text-sm font-semibold text-charcoal-900"
          >
            Add a date
          </button>
        )}
      </div>

      {adding && (
        <div className="mt-4 rounded-2xl border border-gold/40 bg-gold/5 p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-offwhite">
              {pickService ? "Which service?" : "What is different that day?"}
            </p>
            <button
              type="button"
              onClick={close}
              className="min-h-[44px] rounded-lg px-3 text-sm text-muted transition-colors hover:text-offwhite"
            >
              Cancel
            </button>
          </div>
          {pickService ? (
            active.length === 0 ? (
              <p className="mt-2 text-sm text-muted">Add a service to your menu first.</p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                {active.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      close();
                      onAdd("hours", s.id);
                    }}
                    className="min-h-[44px] max-w-full truncate rounded-full border border-subtle px-4 text-sm text-offwhite transition-colors hover:border-gold/50"
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            )
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              {ADD_CHOICES.map((c) => (
                <button
                  key={c.kind}
                  type="button"
                  onClick={() => choose(c.kind)}
                  className="flex min-h-[56px] w-full items-center gap-3 rounded-xl border border-subtle bg-charcoal-800/60 px-3.5 py-2 text-left transition-colors hover:border-gold/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-offwhite">{c.label}</span>
                    <span className="block text-xs text-muted">{c.hint}</span>
                  </span>
                  <Chevron />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {failed && (
        <p role="alert" className="mt-4 text-sm text-muted">
          Couldn&apos;t load your {missing.join(" and ")}, so this list may be missing some. They are
          still live on your booking page.{" "}
          {onShowMissing && (
            <button type="button" onClick={onShowMissing} className="min-h-[44px] text-gold underline">
              See what went wrong
            </button>
          )}
        </p>
      )}

      {count === 0 && !failed && (
        <p className="mt-4 text-sm text-muted">
          {loading ? "Loading your special dates…" : "Nothing special coming up. Every day runs on your usual week."}
        </p>
      )}

      {months.map((month) => (
        <section key={month.key} className="mt-5" aria-label={month.label}>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">{month.label}</h3>
          <ul className="mt-2 divide-y divide-subtle overflow-hidden rounded-2xl border border-subtle bg-charcoal-800/40">
            {month.entries.map((e) => (
              <li key={e.key}>
                <button
                  type="button"
                  onClick={() => onOpen(e)}
                  className="flex min-h-[64px] w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150 ease-out hover:bg-charcoal-700/40"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl border border-subtle bg-charcoal-700/60"
                  >
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                      {WEEKDAY[weekdayOfDateKey(e.date)]}
                    </span>
                    <span className="text-base font-semibold leading-tight text-offwhite">
                      {Number(e.date.slice(8))}
                    </span>
                  </span>
                  <span className="sr-only">{dateLabel(e.date)}:</span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-medium text-offwhite">{e.title}</span>
                    <span className="block break-words text-xs text-muted">{e.sub}</span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                      CHIP[e.kind],
                    )}
                  >
                    {KIND_LABEL[e.kind]}
                  </span>
                  <Chevron />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {count > 0 && (
        <p className="mt-4 text-xs text-muted">
          {loading ? "Still loading the rest… " : ""}
          Tap a date to open it and change it. Past dates drop off the list on their own.
        </p>
      )}
    </Card>
  );
}
