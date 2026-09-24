import { formatPrice, parsePrice } from "@/lib/serviceFields";

/**
 * Booth rent as the API sends it (services/boothRent.ts), and how the pages
 * say it - shared by the owner's team card and the member's Teams page.
 */

export type RentPeriod = "WEEKLY" | "MONTHLY";

export interface RentSummary {
  amountCents: number | null;
  period: RentPeriod | null;
  paidThisPeriodCents: number;
  dueCents: number;
  lastPayment: { date: string; amountCents: number; method: string } | null;
}

export interface RentPayment {
  id: string;
  amountCents: number;
  paidOn: string;
  method: string;
  note: string | null;
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

/** "$150 / week", or null when no rent is set. */
export function describeRent(r: RentSummary): string | null {
  if (r.amountCents === null || r.period === null) return null;
  return `${money(r.amountCents)} / ${r.period === "WEEKLY" ? "week" : "month"}`;
}

/** "Owes $50 this week" / "Paid this week". Null when no rent is set. */
export function rentStatus(r: RentSummary, who: "owner" | "member"): { label: string; owing: boolean } | null {
  if (r.amountCents === null || r.period === null) return null;
  const when = r.period === "WEEKLY" ? "this week" : "this month";
  if (r.dueCents > 0) {
    return { label: `${who === "owner" ? "Owes" : "You owe"} ${money(r.dueCents)} ${when}`, owing: true };
  }
  return { label: `Paid ${when}`, owing: false };
}

/** "Mon, Sep 21" for a YYYY-MM-DD day (no timezone shift). */
export function shortDay(ymd: string): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
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
