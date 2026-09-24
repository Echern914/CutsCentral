import type { Prisma } from "@chairback/db";
import { shopLocalDay, weekStart } from "../engines/insightsWindow.js";

/**
 * BOOTH RENT between a team's shop and one independent member (TeamLink):
 * an amount per calendar week (Mon-Sun) or month, and the payments the owner
 * records. "Paid" means this period's payments add up to the rent. Dates are
 * the team shop's calendar days.
 */

export type RentPeriod = "WEEKLY" | "MONTHLY";
export const PAYMENT_METHODS = ["cash", "zelle", "cashapp", "venmo", "card", "other"] as const;

export interface RentSummary {
  /** Null = no rent set. */
  amountCents: number | null;
  period: RentPeriod | null;
  /** Paid in the current week/month. */
  paidThisPeriodCents: number;
  /** Still owed for the current week/month (never negative). */
  dueCents: number;
  lastPayment: { date: string; amountCents: number; method: string } | null;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** First day of the current week (Monday) or month, in the shop's calendar. */
export function periodStart(period: RentPeriod, today: Date): Date {
  return period === "WEEKLY"
    ? weekStart(today)
    : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
}

export async function rentSummary(
  tx: Prisma.TransactionClient,
  link: { id: string; rentCents: number | null; rentPeriod: RentPeriod | null },
  timezone: string,
  now: Date = new Date(),
): Promise<RentSummary> {
  const last = await tx.boothRentPayment.findFirst({
    where: { linkId: link.id },
    orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }],
    select: { paidOn: true, amountCents: true, method: true },
  });
  let paid = 0;
  if (link.rentCents !== null && link.rentPeriod !== null) {
    const today = shopLocalDay(now, timezone);
    const sum = await tx.boothRentPayment.aggregate({
      where: { linkId: link.id, paidOn: { gte: periodStart(link.rentPeriod, today), lte: today } },
      _sum: { amountCents: true },
    });
    paid = sum._sum.amountCents ?? 0;
  }
  return {
    amountCents: link.rentCents,
    period: link.rentPeriod,
    paidThisPeriodCents: paid,
    dueCents: link.rentCents === null ? 0 : Math.max(0, link.rentCents - paid),
    lastPayment: last
      ? { date: ymd(last.paidOn), amountCents: last.amountCents, method: last.method }
      : null,
  };
}

/** Every payment, newest first. */
export async function rentPayments(tx: Prisma.TransactionClient, linkId: string) {
  const rows = await tx.boothRentPayment.findMany({
    where: { linkId },
    orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }],
    take: 500,
    select: { id: true, amountCents: true, paidOn: true, method: true, note: true },
  });
  return rows.map((r) => ({ ...r, paidOn: ymd(r.paidOn) }));
}
