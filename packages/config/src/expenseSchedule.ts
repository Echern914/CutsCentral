/**
 * SHOP EXPENSES: what the business spends, expanded over a period.
 *
 * A barber enters an expense once - "$300 chair rent, monthly, from Jan 1" or
 * "$84 of product on Oct 3" - and Insights asks "what did I spend between
 * these two days?". The occurrences are never stored: this module expands a
 * schedule over a window at read time, so the same rule answers every period
 * and an edited amount re-prices them all consistently.
 *
 * Feeds the Insights take-home ESTIMATE (revenue from bookings minus the
 * expenses entered). Revenue comes from readChairEvents in the API; nothing
 * here knows about it.
 *
 * 🔴 DATE KEYS ONLY. Every date is a shop-local calendar day as "YYYY-MM-DD".
 * Nothing is ever parsed with `new Date("2026-10-03")` or `new Date(y, m, d)`
 * (device/process zone); arithmetic goes through Date.UTC day numbers, which
 * have no zone. The caller turns its window into keys in the SHOP's zone.
 *
 * Rules:
 *   once     - on its startDate.
 *   weekly   - every 7 days from startDate.
 *   monthly  - on startDate's day-of-month, CLAMPED to month end: an expense
 *              from Jan 31 lands Feb 28 (Feb 29 in a leap year), Mar 31,
 *              Apr 30 - each month clamps on its own, the anchor never drifts.
 *   endDate  - inclusive; nothing after it. Absent = open-ended.
 *   window   - [from, to], both ends inclusive.
 *
 * Archived expenses are excluded by the CALLER (the query), not here.
 *
 * Pure: no I/O, no clock. Imported by client components (subpath only).
 */

export const EXPENSE_CATEGORIES = ["rent", "products", "supplies", "other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CADENCES = ["once", "weekly", "monthly"] as const;
export type ExpenseCadence = (typeof EXPENSE_CADENCES)[number];

/** One line may not exceed $100,000 - mirrors ShopExpense_amount_check. */
export const EXPENSE_MAX_CENTS = 10_000_000;
/** Mirrors ShopExpense_label_check. */
export const EXPENSE_LABEL_MAX = 80;

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  rent: "Rent",
  products: "Products",
  supplies: "Supplies",
  other: "Other",
};

export const EXPENSE_CADENCE_LABELS: Record<ExpenseCadence, string> = {
  once: "One time",
  weekly: "Weekly",
  monthly: "Monthly",
};

/** The fields the expansion needs. Dates are shop-local "YYYY-MM-DD". */
export interface ExpenseSchedule {
  id: string;
  category: ExpenseCategory;
  amountCents: number;
  cadence: ExpenseCadence;
  startDate: string;
  endDate: string | null;
}

export interface ExpenseOccurrence {
  expenseId: string;
  date: string;
  category: ExpenseCategory;
  amountCents: number;
}

export interface ExpenseTotals {
  occurrences: ExpenseOccurrence[];
  totalCents: number;
  /** Every category present, zero where nothing fell in the window. */
  byCategory: Record<ExpenseCategory, number>;
}

const KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date as "YYYY-MM-DD" (rejects 2026-02-30, 2026-13-01). */
export function isDateKey(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const m = KEY.exec(raw);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo - 1);
}

/** Days in a month (month0 zero-based), leap years included. */
export function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** "YYYY-MM-DD" -> whole days since 1970-01-01. Caller has validated the key. */
function dayNumber(key: string): number {
  const m = KEY.exec(key)!;
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

function keyOf(dayNum: number): string {
  return new Date(dayNum * 86_400_000).toISOString().slice(0, 10);
}

function keyFromParts(year: number, month0: number, day: number): string {
  return new Date(Date.UTC(year, month0, day)).toISOString().slice(0, 10);
}

/**
 * The dates (shop-local keys, ascending) on which one expense falls inside
 * [from, to]. Empty for a malformed key or an empty window.
 */
export function expenseDates(
  expense: Pick<ExpenseSchedule, "cadence" | "startDate" | "endDate">,
  from: string,
  to: string,
): string[] {
  if (!isDateKey(expense.startDate) || !isDateKey(from) || !isDateKey(to)) return [];
  if (expense.endDate !== null && !isDateKey(expense.endDate)) return [];
  const start = dayNumber(expense.startDate);
  const lo = Math.max(dayNumber(from), start);
  let hi = dayNumber(to);
  if (expense.endDate !== null) hi = Math.min(hi, dayNumber(expense.endDate));
  if (lo > hi) return [];

  if (expense.cadence === "once") {
    // lo >= start and start <= hi, so the one date is inside iff it is lo.
    return start === lo ? [expense.startDate] : [];
  }

  const out: string[] = [];
  if (expense.cadence === "weekly") {
    // First multiple of 7 days from start that is >= lo.
    const first = start + Math.ceil((lo - start) / 7) * 7;
    for (let n = first; n <= hi; n += 7) out.push(keyOf(n));
    return out;
  }

  // monthly: the anchor day-of-month, clamped per month.
  const sm = KEY.exec(expense.startDate)!;
  const anchorDay = Number(sm[3]);
  const loKey = keyOf(lo);
  const lm = KEY.exec(loKey)!;
  let year = Number(lm[1]);
  let month0 = Number(lm[2]) - 1;
  for (;;) {
    const day = Math.min(anchorDay, daysInMonth(year, month0));
    const n = dayNumber(keyFromParts(year, month0, day));
    if (n > hi) break;
    if (n >= lo) out.push(keyOf(n));
    month0++;
    if (month0 === 12) {
      month0 = 0;
      year++;
    }
  }
  return out;
}

/** Every expense's occurrences in [from, to], with the total and per-category sums. */
export function expandExpenses(expenses: readonly ExpenseSchedule[], from: string, to: string): ExpenseTotals {
  const byCategory: Record<ExpenseCategory, number> = { rent: 0, products: 0, supplies: 0, other: 0 };
  const occurrences: ExpenseOccurrence[] = [];
  let totalCents = 0;
  for (const e of expenses) {
    for (const date of expenseDates(e, from, to)) {
      occurrences.push({ expenseId: e.id, date, category: e.category, amountCents: e.amountCents });
      byCategory[e.category] += e.amountCents;
      totalCents += e.amountCents;
    }
  }
  occurrences.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { occurrences, totalCents, byCategory };
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 3, 2026" from a key, with no zone involved. */
export function fmtDateKey(key: string): string {
  if (!isDateKey(key)) return key;
  const m = KEY.exec(key)!;
  return `${MONTH_SHORT[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/**
 * How the schedule reads in a list: "Once, Oct 3, 2026" · "Every Monday from
 * Oct 5, 2026" · "Monthly on the 31st (or the month's last day) from …".
 */
export function expenseScheduleWords(e: Pick<ExpenseSchedule, "cadence" | "startDate" | "endDate">): string {
  if (!isDateKey(e.startDate)) return "";
  const start = fmtDateKey(e.startDate);
  const until = e.endDate && isDateKey(e.endDate) ? ` until ${fmtDateKey(e.endDate)}` : "";
  if (e.cadence === "once") return `Once, ${start}`;
  if (e.cadence === "weekly") {
    const weekday = WEEKDAY_NAMES[new Date(dayNumber(e.startDate) * 86_400_000).getUTCDay()];
    return `Every ${weekday} from ${start}${until}`;
  }
  const day = Number(KEY.exec(e.startDate)![3]);
  const clamp = day > 28 ? " (or the month's last day)" : "";
  return `Monthly on the ${ordinal(day)}${clamp} from ${start}${until}`;
}
