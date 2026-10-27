"use server";

import { apiGet, apiSend } from "@/lib/api";
import type { ExpenseCadence, ExpenseCategory } from "@chairback/config/expenseSchedule";

/**
 * SHOP EXPENSES (apps/api routes/insightsExpenses.ts): the barber's own costs,
 * feeding the take-home estimate on Insights. Kept apart from ./actions so
 * the tests that mock that module are not asked for these.
 */

export interface ExpenseItem {
  id: string;
  category: ExpenseCategory;
  label: string | null;
  amountCents: number;
  cadence: ExpenseCadence;
  /** Shop-local YYYY-MM-DD. */
  startDate: string;
  endDate: string | null;
}

export interface ExpenseInput {
  category: ExpenseCategory;
  label: string | null;
  amountCents: number;
  cadence: ExpenseCadence;
  startDate: string;
  endDate: string | null;
}

export interface ExpenseList {
  expenses: ExpenseItem[];
  /** The shop's calendar day - the form's default date. */
  today: string;
}

export async function listExpensesAction(): Promise<ExpenseList | null> {
  const res = await apiGet<ExpenseList>("/api/insights/expenses");
  return res.ok ? (res.data ?? null) : null;
}

/** The API's refusal codes, as sentences. */
function sentenceFor(status: number, code: string | undefined): string {
  if (status === 0) return "No answer from ChairBack. Check your connection, then look at your expenses before saving again.";
  if (status === 403) return "Only the owner or a manager can change expenses.";
  if (status === 404) return "That expense isn't there any more. Close this and look at the list.";
  switch (code) {
    case "amountCents_invalid":
      return "Enter an amount between $0.01 and $100,000.";
    case "end_before_start":
      return "The end date can't be before the start.";
    case "once_has_no_end":
      return "A one-time expense has no end date.";
    case "date_invalid":
    case "date_out_of_range":
    case "startDate_invalid":
    case "endDate_invalid":
      return "Pick a real date.";
    case "label_invalid":
      return "Keep the note to 80 characters.";
    default:
      return "Couldn't save that expense. Check the fields and try again.";
  }
}

/** Add one (no id) or replace one's fields (id). */
export async function saveExpenseAction(
  input: ExpenseInput,
  id?: string,
): Promise<{ ok: true; expense: ExpenseItem } | { ok: false; error: string }> {
  const res = id
    ? await apiSend<{ expense: ExpenseItem }>("PUT", `/api/insights/expenses/${encodeURIComponent(id)}`, input)
    : await apiSend<{ expense: ExpenseItem }>("POST", "/api/insights/expenses", input);
  if (res.ok && res.data) return { ok: true, expense: res.data.expense };
  return { ok: false, error: sentenceFor(res.status, res.error) };
}

/** Archive: it stops counting in every period, past ones included. */
export async function archiveExpenseAction(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await apiSend<{ ok: boolean }>("DELETE", `/api/insights/expenses/${encodeURIComponent(id)}`);
  if (res.ok) return { ok: true };
  return {
    ok: false,
    error:
      res.status === 0
        ? "No answer from ChairBack. Check your connection, then look at the list before trying again."
        : res.status === 404
          ? "That expense was already removed."
          : "Couldn't remove it. Try again.",
  };
}
