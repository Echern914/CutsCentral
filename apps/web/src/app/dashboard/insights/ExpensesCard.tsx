"use client";

import { useEffect, useRef, useState } from "react";
import {
  EXPENSE_CADENCE_LABELS,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_LABEL_MAX,
  EXPENSE_MAX_CENTS,
  expenseScheduleWords,
  isDateKey,
  type ExpenseCadence,
  type ExpenseCategory,
} from "@chairback/config/expenseSchedule";
import { useVocab } from "@/components/VocabProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { cn } from "@/lib/cn";
import { chip, Field, FormFooter, Group, INPUT } from "../booking/formkit";
import {
  archiveExpenseAction,
  listExpensesAction,
  saveExpenseAction,
  type ExpenseItem,
} from "./expenseActions";

/**
 * EXPENSES on Insights: what the barber spends (rent they pay, products,
 * supplies, other), one-time or recurring, so the page can show a take-home
 * ESTIMATE next to revenue.
 *
 * The card lists what was entered and what of it fell in the page's range
 * (the API expands the schedules - @chairback/config/expenseSchedule - so
 * this card never re-does that arithmetic). Add / edit / remove happen in a
 * Dialog whose outcome - an error, or the remove confirmation - lives in the
 * FOOTER beside the button, never in a toast a phone cannot see.
 */

export interface ExpenseSummary {
  totalCents: number;
  byCategory: Record<ExpenseCategory, number>;
}

/** "$1,200" / "$84.50" / "-$318.50" from cents. */
export function fmtCents(cents: number): string {
  const abs = Math.abs(cents);
  const whole = abs % 100 === 0;
  const text = (abs / 100).toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
  return `${cents < 0 ? "-" : ""}$${text}`;
}

const CADENCE_SUFFIX: Record<ExpenseCadence, string> = { once: "", weekly: " / wk", monthly: " / mo" };

export function ExpensesCard({
  summary,
  periodLabel,
  pending,
  onChanged,
}: {
  /** What fell in the page's range, from GET /api/insights. */
  summary: ExpenseSummary | null;
  periodLabel: string;
  pending: boolean;
  /** Re-read the page's numbers after a change. */
  onChanged: () => void;
}) {
  const [items, setItems] = useState<ExpenseItem[] | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<{ item: ExpenseItem | null } | null>(null);

  async function reload() {
    const r = await listExpensesAction().catch(() => null);
    if (r) {
      setItems(r.expenses);
      setToday(r.today);
      setFailed(false);
    } else {
      setFailed(true);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function changed() {
    setEditing(null);
    void reload();
    onChanged();
  }

  const spent = summary
    ? EXPENSE_CATEGORIES.filter((c) => summary.byCategory[c] > 0).map((c) => ({
        category: c,
        cents: summary.byCategory[c],
      }))
    : [];

  return (
    <Card className="overflow-hidden" id="expenses">
      <CardHeader
        title="Expenses"
        subtitle="Rent you pay, products, supplies - one-time or recurring. Used for the take-home estimate."
        action={
          <button
            type="button"
            onClick={() => setEditing({ item: null })}
            disabled={items === null && !failed}
            className="h-11 shrink-0 rounded-lg border border-gold/40 px-3 text-sm font-medium text-gold transition-colors duration-150 ease-out hover:bg-gold/10 disabled:opacity-50"
          >
            Add expense
          </button>
        }
      />

      {/* What fell in this range, by category. */}
      <div className={cn("min-w-0 px-5 py-4 transition-opacity duration-150 ease-out", pending && "opacity-60")}>
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[11px] uppercase tracking-wide text-muted">{periodLabel}</p>
          <p className="font-display text-lg tabular-nums text-offwhite" data-testid="expenses-range-total">
            {fmtCents(summary?.totalCents ?? 0)}
          </p>
        </div>
        {spent.length > 0 ? (
          <dl className="mt-2 flex flex-col gap-1.5 text-sm">
            {spent.map((s) => (
              <div key={s.category} className="flex items-center justify-between gap-3">
                <dt className="text-muted">{EXPENSE_CATEGORY_LABELS[s.category]}</dt>
                <dd className="font-medium tabular-nums text-offwhite">{fmtCents(s.cents)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-1 text-[11px] text-muted">Nothing you&apos;ve entered falls in this range.</p>
        )}
      </div>

      <div className="border-t border-subtle">
        {failed && items === null ? (
          <p role="alert" className="px-5 py-4 text-sm text-danger-soft">
            Couldn&apos;t load your expenses.{" "}
            <button type="button" onClick={() => void reload()} className="underline underline-offset-2">
              Try again
            </button>
          </p>
        ) : items === null ? (
          <p className="px-5 py-4 text-sm text-muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">
            No expenses yet. Add your rent, product and supply costs to see what you take home.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-subtle">
            {items.map((e) => (
              <li key={e.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => setEditing({ item: e })}
                  aria-label={`Edit ${e.label ?? EXPENSE_CATEGORY_LABELS[e.category]} expense`}
                  className="flex min-h-[44px] w-full min-w-0 items-center justify-between gap-3 px-5 py-3 text-left transition-colors duration-150 ease-out hover:bg-charcoal-800/40"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm text-offwhite">
                      {EXPENSE_CATEGORY_LABELS[e.category]}
                      {e.label ? <span className="text-muted"> · {e.label}</span> : null}
                    </span>
                    <span className="text-[11px] text-muted [overflow-wrap:anywhere]">
                      {expenseScheduleWords(e)}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-medium tabular-nums text-offwhite">
                    {fmtCents(e.amountCents)}
                    <span className="text-muted">{CADENCE_SUFFIX[e.cadence]}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {editing && (
        <ExpenseDialog
          open
          item={editing.item}
          today={today}
          onClose={() => setEditing(null)}
          onDone={changed}
        />
      )}
    </Card>
  );
}

/** "$1,200.50" / "1200" -> cents, or null when it is not a usable amount. */
export function parseDollars(raw: string): number | null {
  const t = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return cents >= 1 && cents <= EXPENSE_MAX_CENTS ? cents : null;
}

function centsToField(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export function ExpenseDialog({
  open,
  item,
  today,
  onClose,
  onDone,
}: {
  open: boolean;
  /** null = a new expense. */
  item: ExpenseItem | null;
  /** The shop's calendar day (default date); null until the list loads. */
  today: string | null;
  onClose: () => void;
  /** Saved or removed: the caller closes this and re-reads. */
  onDone: () => void;
}) {
  const vocab = useVocab();
  const [amount, setAmount] = useState(item ? centsToField(item.amountCents) : "");
  const [category, setCategory] = useState<ExpenseCategory>(item?.category ?? "rent");
  const [cadence, setCadence] = useState<ExpenseCadence>(item?.cadence ?? "monthly");
  const [startDate, setStartDate] = useState(item?.startDate ?? today ?? "");
  const [endDate, setEndDate] = useState(item?.endDate ?? "");
  const [label, setLabel] = useState(item?.label ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // A ref, not just `pending`: a fast double tap lands before React re-renders.
  const inFlight = useRef(false);

  const once = cadence === "once";
  const amountCents = parseDollars(amount);
  const end = once ? "" : endDate;
  const problem =
    amountCents === null
      ? "Enter an amount between $0.01 and $100,000."
      : !isDateKey(startDate)
        ? once
          ? "Pick the date you paid it."
          : "Pick the date it starts."
        : end && !isDateKey(end)
          ? "Pick a real end date, or leave it blank."
          : end && end < startDate
            ? "The end date can't be before the start."
            : null;
  const preview = isDateKey(startDate)
    ? expenseScheduleWords({ cadence, startDate, endDate: end && isDateKey(end) ? end : null })
    : null;

  async function save() {
    if (inFlight.current) return;
    if (problem || amountCents === null) {
      setError(problem);
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const res = await saveExpenseAction(
        {
          category,
          label: label.trim() ? label.trim() : null,
          amountCents,
          cadence,
          startDate,
          endDate: end ? end : null,
        },
        item?.id,
      );
      if (res.ok) onDone();
      else setError(res.error);
    } catch {
      setError("No answer from ChairBack. Check your connection, then look at your expenses before saving again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  async function remove() {
    if (inFlight.current || !item) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const res = await archiveExpenseAction(item.id);
      if (res.ok) onDone();
      else setError(res.error);
    } catch {
      setError("No answer from ChairBack. Check your connection, then look at the list before trying again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={item ? "Edit expense" : "Add expense"}
      footer={
        confirmRemove ? (
          <div className="flex w-full flex-col gap-2" data-testid="expense-remove-confirm">
            <p className="text-sm text-offwhite">
              Remove this expense? It stops counting in every range, past ones too.
            </p>
            {error && (
              <p role="alert" className="text-sm text-danger-soft">
                {error}
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setConfirmRemove(false);
                  setError(null);
                }}
                disabled={pending}
                className="h-11 rounded-xl border border-subtle px-4 text-sm text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
              >
                Keep it
              </button>
              <button
                type="button"
                onClick={() => void remove()}
                disabled={pending}
                className="h-11 rounded-xl border border-danger-soft/40 px-4 text-sm font-semibold text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/10 disabled:opacity-50"
              >
                {pending ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex w-full flex-col gap-2">
            <FormFooter
              error={error}
              label={item ? "Save changes" : "Add expense"}
              pendingLabel="Saving…"
              pending={pending}
              onSubmit={() => void save()}
            />
            {item && (
              <button
                type="button"
                onClick={() => {
                  setConfirmRemove(true);
                  setError(null);
                }}
                disabled={pending}
                className="h-11 rounded-xl px-4 text-sm text-muted transition-colors duration-150 ease-out hover:text-danger-soft disabled:opacity-50"
              >
                Remove this expense
              </button>
            )}
          </div>
        )
      }
    >
      <div className="flex min-w-0 flex-col gap-4" data-testid="expense-form">
        <Group title="What">
          <Field label="Amount">
            <input
              inputMode="decimal"
              className={INPUT}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="300"
              aria-label="Amount in dollars"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {EXPENSE_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
                className={chip(category === c)}
              >
                {EXPENSE_CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
          {category === "rent" && (
            <p className="text-[11px] text-muted/80">
              Rent you pay for your {vocab.stationNoun}, or for your space.
            </p>
          )}
          <Field label={`Note (optional)`} hint={`Only you see this. Up to ${EXPENSE_LABEL_MAX} characters.`}>
            <input
              className={INPUT}
              value={label}
              maxLength={EXPENSE_LABEL_MAX}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Product restock"
            />
          </Field>
        </Group>

        <Group title="When">
          <div className="grid grid-cols-3 gap-2">
            {(["once", "weekly", "monthly"] as const).map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={cadence === c}
                onClick={() => setCadence(c)}
                className={chip(cadence === c)}
              >
                {EXPENSE_CADENCE_LABELS[c]}
              </button>
            ))}
          </div>
          <div className={cn("grid gap-2", !once && "grid-cols-2")}>
            <Field label={once ? "Date" : "Starts"}>
              <input type="date" className={INPUT} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </Field>
            {!once && (
              <Field label="Ends (optional)" hint="Blank = keeps going.">
                <input type="date" className={INPUT} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </Field>
            )}
          </div>
          {preview && (
            <p className="text-[11px] text-muted [overflow-wrap:anywhere]" data-testid="expense-preview">
              {preview}
            </p>
          )}
        </Group>
      </div>
    </Dialog>
  );
}
