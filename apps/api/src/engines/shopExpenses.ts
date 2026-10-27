import type { Prisma } from "@chairback/db";
import {
  expandExpenses,
  type ExpenseCadence,
  type ExpenseCategory,
  type ExpenseSchedule,
} from "@chairback/config/expenseSchedule";

/**
 * SHOP EXPENSES for Insights: the rows a barber entered, and their total over
 * one Insights window.
 *
 * The schedule rule (once / weekly / monthly with month-end clamp) lives in
 * @chairback/config/expenseSchedule - this file only reads rows and hands them
 * over as date KEYS. Revenue is NOT computed here: the take-home estimate is
 * readChairEvents' revenue minus this total, assembled in routes/insights.ts.
 *
 * 🔴 Reads run inside the caller's runWithShop transaction (ShopExpense is a
 * FORCE-RLS tenant table) and ALSO filter on shopId - two layers, so neither a
 * missing policy nor a missing filter alone can leak another shop's rows.
 */

/** A DATE column comes back as that day's UTC midnight: its key is the ISO date. */
export function dateKeyOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" (already validated) -> the Date Prisma writes to a DATE column. */
export function dateFromKey(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

export interface ExpenseRow {
  id: string;
  category: ExpenseCategory;
  label: string | null;
  amountCents: number;
  cadence: ExpenseCadence;
  startDate: string;
  endDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export const EXPENSE_SELECT = {
  id: true,
  category: true,
  label: true,
  amountCents: true,
  cadence: true,
  startDate: true,
  endDate: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ShopExpenseSelect;

type SelectedExpense = Prisma.ShopExpenseGetPayload<{ select: typeof EXPENSE_SELECT }>;

export function toExpenseRow(e: SelectedExpense): ExpenseRow {
  return {
    id: e.id,
    // CHECK-pinned in the migration, so the cast cannot lie.
    category: e.category as ExpenseCategory,
    label: e.label,
    amountCents: e.amountCents,
    cadence: e.cadence as ExpenseCadence,
    startDate: dateKeyOf(e.startDate),
    endDate: e.endDate ? dateKeyOf(e.endDate) : null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

/** The shop's live (not archived) expenses, newest first. */
export async function listShopExpenses(
  tx: Prisma.TransactionClient,
  shopId: string,
): Promise<ExpenseRow[]> {
  const rows = await tx.shopExpense.findMany({
    where: { shopId, archivedAt: null },
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
    select: EXPENSE_SELECT,
  });
  return rows.map(toExpenseRow);
}

export interface ExpenseSummary {
  totalCents: number;
  byCategory: Record<ExpenseCategory, number>;
}

/**
 * Expenses falling in [fromKey, toKey] (shop-local, inclusive). Only rows that
 * could touch the window are read; the expansion decides the rest.
 */
export async function expenseSummaryForWindow(
  tx: Prisma.TransactionClient,
  shopId: string,
  fromKey: string,
  toKey: string,
): Promise<ExpenseSummary> {
  const rows = await tx.shopExpense.findMany({
    where: {
      shopId,
      archivedAt: null,
      startDate: { lte: dateFromKey(toKey) },
      OR: [{ endDate: null }, { endDate: { gte: dateFromKey(fromKey) } }],
    },
    select: EXPENSE_SELECT,
  });
  const schedules: ExpenseSchedule[] = rows.map((r) => {
    const row = toExpenseRow(r);
    return {
      id: row.id,
      category: row.category,
      amountCents: row.amountCents,
      cadence: row.cadence,
      startDate: row.startDate,
      endDate: row.endDate,
    };
  });
  const { totalCents, byCategory } = expandExpenses(schedules, fromKey, toKey);
  return { totalCents, byCategory };
}
