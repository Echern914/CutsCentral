import { formatPrice, parsePrice } from "@/lib/serviceFields";

/**
 * Booth rent as the API sends it (services/boothRent.ts), and how the pages
 * say it - shared by the owner's team card and the member's Teams page, so
 * both read the same numbers the same way.
 */

export type RentPeriod = "WEEKLY" | "MONTHLY";

export interface RentSummary {
  /** The period today falls in, while rent is in effect. */
  current: { start: string; end: string; amountCents: number; paidCents: number; dueCents: number } | null;
  /** Everything due so far minus everything paid, when positive. */
  balanceCents: number;
  /** Paid beyond everything due so far. */
  creditCents: number;
  /** Periods not fully paid, oldest first. Payments pay the oldest first. */
  unpaid: { start: string; end: string; amountCents: number; dueCents: number }[];
  rate: { amountCents: number; period: RentPeriod; since: string } | null;
  /** A start, change or stop that hasn't taken effect yet. */
  scheduled: { amountCents: number | null; period: RentPeriod | null; startsOn: string } | null;
  /** When a change made today would take effect (null: no rent in effect). */
  nextChangeOn: string | null;
  lastPayment: { date: string; amountCents: number; method: string } | null;
}

export interface RentPayment {
  id: string;
  amountCents: number;
  paidOn: string;
  method: string;
  note: string | null;
  voided: boolean;
}

/** One rent entry: a start, a change, or a stop (amountCents null). */
export interface RentRate {
  id: string;
  amountCents: number | null;
  period: RentPeriod | null;
  startsOn: string;
  voided: boolean;
}

export interface RentHistory {
  summary: RentSummary;
  payments: RentPayment[];
  rates: RentRate[];
}

export const PAYMENT_METHODS = [
  { key: "cash", label: "Cash" },
  { key: "zelle", label: "Zelle" },
  { key: "cashapp", label: "Cash App" },
  { key: "venmo", label: "Venmo" },
  { key: "card", label: "Card" },
  { key: "other", label: "Other" },
] as const;

export const money = (cents: number) => formatPrice(cents / 100);

export const methodLabel = (key: string) =>
  PAYMENT_METHODS.find((m) => m.key === key)?.label ?? "Other";

export const periodNoun = (p: RentPeriod) => (p === "WEEKLY" ? "week" : "month");

/** "$150 / week". */
export function describeRate(amountCents: number, period: RentPeriod): string {
  return `${money(amountCents)} / ${periodNoun(period)}`;
}

const day = (ymd: string) => new Date(`${ymd}T12:00:00Z`);

/** "Mon, Sep 21" for a YYYY-MM-DD day (no timezone shift). */
export function shortDay(ymd: string): string {
  return day(ymd).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Sep 21". */
export function monthDay(ymd: string): string {
  return day(ymd).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Sep 21–27", or "Sep 28–Oct 4" across a month. */
export function dayRange(start: string, end: string): string {
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return `${monthDay(start)}–${sameMonth ? String(Number(end.slice(8, 10))) : monthDay(end)}`;
}

/** Anything to show at all: rent now or coming, money owed or ahead, a payment. */
export function hasRent(r: RentSummary): boolean {
  return r.rate !== null || r.scheduled !== null || r.balanceCents > 0 || r.creditCents > 0 || r.lastPayment !== null;
}

export interface RentLines {
  /** "$150 / week", or "Not set". */
  rate: string;
  /** "This week (Sep 21–27): $150 due". */
  current: string | null;
  /** The whole balance, never just this period's. */
  total: { label: string; tone: "owing" | "credit" | "settled" } | null;
  /** "Changes to $200 / week on Mon, Sep 28". */
  next: string | null;
}

/**
 * The card's lines. The TOTAL is always shown next to this period: payments
 * pay the oldest period first, so "this week: paid" can only appear once
 * every earlier week is paid too.
 */
export function rentLines(r: RentSummary, who: "owner" | "member"): RentLines {
  const current =
    r.current && r.rate
      ? `This ${periodNoun(r.rate.period)} (${dayRange(r.current.start, r.current.end)}): ${
          r.current.dueCents === 0
            ? "paid"
            : r.current.paidCents > 0
              ? `${money(r.current.dueCents)} of ${money(r.current.amountCents)} due`
              : `${money(r.current.dueCents)} due`
        }`
      : null;

  let total: RentLines["total"] = null;
  if (r.balanceCents > 0) {
    const since = r.unpaid[0] ? ` · unpaid since ${monthDay(r.unpaid[0].start)}` : "";
    total = { label: `${who === "owner" ? "Owes" : "You owe"} ${money(r.balanceCents)} in total${since}`, tone: "owing" };
  } else if (r.creditCents > 0) {
    total = { label: `${money(r.creditCents)} credit (paid ahead)`, tone: "credit" };
  } else if (r.rate || r.lastPayment) {
    total = { label: "All paid up", tone: "settled" };
  }

  let next: string | null = null;
  const s = r.scheduled;
  if (s) {
    if (s.amountCents === null || s.period === null) next = `Stops on ${shortDay(s.startsOn)}`;
    else if (r.rate) next = `Changes to ${describeRate(s.amountCents, s.period)} on ${shortDay(s.startsOn)}`;
    else next = `Starts ${shortDay(s.startsOn)} at ${describeRate(s.amountCents, s.period)}`;
  }

  return { rate: r.rate ? describeRate(r.rate.amountCents, r.rate.period) : "Not set", current, total, next };
}

/** A typed amount in cents - the same parser as every price field - or why not. */
export function centsFromInput(raw: string): { ok: true; cents: number } | { ok: false; error: string } {
  const parsed = parsePrice(raw);
  if (!parsed.ok) return { ok: false, error: "Enter an amount like 150 or 150.50" };
  if (parsed.value === null || parsed.value <= 0) return { ok: false, error: "Enter an amount above $0" };
  if (parsed.value > 100_000) return { ok: false, error: "That's more than $100,000" };
  return { ok: true, cents: Math.round(parsed.value * 100) };
}

/** Today in this browser as YYYY-MM-DD. */
export function todayYmd(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}
