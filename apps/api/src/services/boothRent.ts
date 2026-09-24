import type { Prisma } from "@chairback/db";
import { shopLocalDay } from "../engines/insightsWindow.js";

/**
 * BOOTH RENT between a team's shop and one independent member - a manual
 * tracker, nothing more: no collection, no penalties, no accounting.
 *
 *  - The RATE HISTORY (BoothRentRate) has one row per start / change / stop.
 *    A row applies from its startsOn until the next row, and its periods (a
 *    week, or a month on the same day of the month) run from its startsOn.
 *    Rent is due for every period that has begun; none before the first
 *    start date.
 *  - A change or stop always starts at the NEXT period boundary, so a period
 *    that has begun keeps the rate it started with, and so does every period
 *    before it.
 *  - PAYMENTS pay the oldest unpaid period first. What's left over is a credit.
 *  - A MISTAKE in either is voided: it stays in the history, marked, and stops
 *    counting. Nothing that has taken effect is deleted.
 *
 * Everything below `ledger` is computed on read from those two tables. Dates
 * are the team shop's calendar days as UTC midnights (the Insights convention).
 */

export type RentPeriod = "WEEKLY" | "MONTHLY";
export const PAYMENT_METHODS = ["cash", "zelle", "cashapp", "venmo", "card", "other"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A ceiling on one read's work: 20 years of weekly rent. */
const MAX_PERIODS = 1040;

export interface RateRow {
  amountCents: number | null;
  period: RentPeriod | null;
  startsOn: Date;
  createdAt: Date;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** `anchor` plus n periods. Months keep the anchor's day, clamped to short months. */
export function addPeriods(anchor: Date, period: RentPeriod, n: number): Date {
  if (period === "WEEKLY") return new Date(anchor.getTime() + n * 7 * DAY_MS);
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + n;
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(anchor.getUTCDate(), daysInMonth)));
}

const byStart = (a: RateRow, b: RateRow) =>
  a.startsOn.getTime() - b.startsOn.getTime() || a.createdAt.getTime() - b.createdAt.getTime();

/** The rows that count: oldest first, and for a shared startsOn only the latest. */
export function effectiveRates<T extends RateRow>(rows: T[]): T[] {
  const out: T[] = [];
  for (const r of [...rows].sort(byStart)) {
    if (out.length && out[out.length - 1]!.startsOn.getTime() === r.startsOn.getTime()) out.pop();
    out.push(r);
  }
  return out;
}

/** The row in effect on `day` (a stop row means no rent), or null before any start. */
export function rateOn<T extends RateRow>(rows: T[], day: Date): T | null {
  let found: T | null = null;
  for (const r of effectiveRates(rows)) if (r.startsOn <= day) found = r;
  return found;
}

export interface Period {
  start: Date;
  end: Date;
  amountCents: number;
}

/** Every period that has begun by `today`, oldest first. */
export function periodsThrough(rows: RateRow[], today: Date): Period[] {
  const rates = effectiveRates(rows);
  const out: Period[] = [];
  rates.forEach((r, i) => {
    if (r.amountCents === null || r.period === null) return;
    const next = rates[i + 1]?.startsOn ?? null;
    for (let k = 0; out.length < MAX_PERIODS; k++) {
      const start = addPeriods(r.startsOn, r.period, k);
      if (start > today || (next && start >= next)) break;
      let end = new Date(addPeriods(r.startsOn, r.period, k + 1).getTime() - DAY_MS);
      if (next && end >= next) end = new Date(next.getTime() - DAY_MS);
      out.push({ start, end, amountCents: r.amountCents });
    }
  });
  return out;
}

/** The first period boundary after `today` for the rent in effect, or null if none is. */
export function nextBoundary(rows: RateRow[], today: Date): Date | null {
  const r = rateOn(rows, today);
  if (!r || r.amountCents === null || r.period === null) return null;
  let k = 1;
  while (addPeriods(r.startsOn, r.period, k) <= today) k++;
  return addPeriods(r.startsOn, r.period, k);
}

export interface Ledger {
  current: { start: string; end: string; amountCents: number; paidCents: number; dueCents: number } | null;
  /** Everything due so far minus everything paid, when that's positive. */
  balanceCents: number;
  /** Paid beyond everything due so far. */
  creditCents: number;
  /** Periods not fully paid, oldest first (the current one included). */
  unpaid: { start: string; end: string; amountCents: number; dueCents: number }[];
}

/** Payments pay the oldest period first. Pure: rates, the paid total, today. */
export function ledger(rows: RateRow[], paidCents: number, today: Date): Ledger {
  const periods = periodsThrough(rows, today);
  let left = paidCents;
  let due = 0;
  const allocated = periods.map((p) => {
    const paid = Math.min(p.amountCents, left);
    left -= paid;
    due += p.amountCents;
    return { ...p, paidCents: paid, dueCents: p.amountCents - paid };
  });
  const cur = allocated.find((p) => p.start <= today && today <= p.end) ?? null;
  return {
    current: cur
      ? { start: ymd(cur.start), end: ymd(cur.end), amountCents: cur.amountCents, paidCents: cur.paidCents, dueCents: cur.dueCents }
      : null,
    balanceCents: Math.max(0, due - paidCents),
    creditCents: Math.max(0, paidCents - due),
    unpaid: allocated
      .filter((p) => p.dueCents > 0)
      .map((p) => ({ start: ymd(p.start), end: ymd(p.end), amountCents: p.amountCents, dueCents: p.dueCents })),
  };
}

// ---- Reading and writing (both sides see the SAME summary) -----------------

type Tx = Prisma.TransactionClient;

export interface RentSummary extends Ledger {
  /** The rent in effect today, and since when. Null = none. */
  rate: { amountCents: number; period: RentPeriod; since: string } | null;
  /** A start, change or stop that hasn't taken effect yet. */
  scheduled: { amountCents: number | null; period: RentPeriod | null; startsOn: string } | null;
  /** When a change made today would take effect (null: no rent in effect). */
  nextChangeOn: string | null;
  /**
   * With no rent in effect: the earliest day a new start may use (null: only
   * the year window applies - there's no history yet).
   */
  earliestStart: string | null;
  lastPayment: { date: string; amountCents: number; method: string } | null;
}

/** The rate rows that count toward rent: every one not voided. */
function rates(tx: Tx, linkId: string) {
  return tx.boothRentRate.findMany({
    where: { linkId, voidedAt: null },
    select: { id: true, amountCents: true, period: true, startsOn: true, createdAt: true },
  });
}

/**
 * The earliest day rent may (re)start when none is in effect. Never before
 * what has already taken effect - the past is never re-priced - and, once
 * there is a history, never before the member was last approved onto the
 * team, so rejoining can't bill the time they were away. A first start may
 * reach back (a booth renter who was already paying before ChairBack).
 */
export function earliestStart(rows: RateRow[], today: Date, approvedDay: Date | null): Date | null {
  const begun = rateOn(rows, today);
  if (!begun) return null;
  return approvedDay && approvedDay > begun.startsOn ? approvedDay : begun.startsOn;
}

/** The link's last approval, as the team shop's calendar day. */
async function approvedDay(tx: Tx, linkId: string, timezone: string): Promise<Date | null> {
  const link = await tx.teamLink.findUnique({ where: { id: linkId }, select: { approvedAt: true } });
  return link?.approvedAt ? shopLocalDay(link.approvedAt, timezone) : null;
}

export async function rentSummary(
  tx: Tx,
  linkId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<RentSummary> {
  const today = shopLocalDay(now, timezone);
  const rows = await rates(tx, linkId);
  const paid = await tx.boothRentPayment.aggregate({
    where: { linkId, voidedAt: null },
    _sum: { amountCents: true },
  });
  const last = await tx.boothRentPayment.findFirst({
    where: { linkId, voidedAt: null },
    orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }],
    select: { paidOn: true, amountCents: true, method: true },
  });
  const inEffect = rateOn(rows, today);
  const upcoming = effectiveRates(rows).find((r) => r.startsOn > today) ?? null;
  const next = nextBoundary(rows, today);
  const earliest = next ? null : earliestStart(rows, today, await approvedDay(tx, linkId, timezone));
  return {
    ...ledger(rows, paid._sum.amountCents ?? 0, today),
    rate:
      inEffect && inEffect.amountCents !== null && inEffect.period !== null
        ? { amountCents: inEffect.amountCents, period: inEffect.period, since: ymd(inEffect.startsOn) }
        : null,
    scheduled: upcoming
      ? { amountCents: upcoming.amountCents, period: upcoming.period, startsOn: ymd(upcoming.startsOn) }
      : null,
    nextChangeOn: next ? ymd(next) : null,
    earliestStart: earliest ? ymd(earliest) : null,
    lastPayment: last ? { date: ymd(last.paidOn), amountCents: last.amountCents, method: last.method } : null,
  };
}

export type SetRentResult =
  | { ok: true; startsOn: string }
  | { ok: false; error: "start_required" | "start_too_early" | "start_out_of_range" };

/** One rent write per member at a time: two taps can't interleave. */
async function lockLink(tx: Tx, linkId: string) {
  await tx.$queryRaw`SELECT id FROM "TeamLink" WHERE id = ${linkId} FOR UPDATE`;
}

/**
 * Start, change or stop the rent (amountCents null = stop).
 *  - Rent in effect: the new row starts at the NEXT period boundary; the
 *    current period and everything before it keep their rate.
 *  - No rent in effect: an explicit start date is required (none is
 *    invented), within a year of today, and not before `earliestStart`.
 *
 * A new row on the same day as an existing one supersedes it; voiding the new
 * row brings the old one back (an undo, never a gap). A row scheduled for a
 * different future day that this one displaces never took effect: it is
 * voided - kept in the history, no longer counted.
 */
export async function setRent(
  tx: Tx,
  input: {
    linkId: string;
    amountCents: number | null;
    period: RentPeriod | null;
    startsOn: Date | null;
    userId: string;
  },
  timezone: string,
  now: Date = new Date(),
): Promise<SetRentResult> {
  await lockLink(tx, input.linkId);
  const today = shopLocalDay(now, timezone);
  const rows = await rates(tx, input.linkId);
  const displace = (keep: Date | null) =>
    tx.boothRentRate.updateMany({
      where: {
        linkId: input.linkId,
        voidedAt: null,
        startsOn: { gt: today, ...(keep ? { not: keep } : {}) },
      },
      data: { voidedAt: now, voidedById: input.userId },
    });
  let startsOn = nextBoundary(rows, today);
  if (!startsOn) {
    if (input.amountCents === null) {
      // No rent in effect: stopping only cancels a start that hasn't begun.
      await displace(null);
      return { ok: true, startsOn: ymd(today) };
    }
    if (!input.startsOn) return { ok: false, error: "start_required" };
    // A year either way: a mistyped year would otherwise bill for decades.
    if (Math.abs(input.startsOn.getTime() - today.getTime()) > 366 * DAY_MS) {
      return { ok: false, error: "start_out_of_range" };
    }
    const earliest = earliestStart(rows, today, await approvedDay(tx, input.linkId, timezone));
    if (earliest && input.startsOn < earliest) return { ok: false, error: "start_too_early" };
    startsOn = input.startsOn;
  }
  await displace(startsOn);
  await tx.boothRentRate.create({
    data: {
      linkId: input.linkId,
      amountCents: input.amountCents,
      period: input.amountCents === null ? null : input.period,
      startsOn,
      createdById: input.userId,
    },
  });
  return { ok: true, startsOn: ymd(startsOn) };
}

/**
 * A member left or was removed: rent stops at the next period boundary (the
 * period they were in is still owed), and a start that hasn't begun is
 * cancelled. What they owe and every payment stay recorded - and visible to
 * both sides, read-only.
 */
export async function stopRentOnLeave(tx: Tx, linkId: string, timezone: string, userId: string) {
  await setRent(tx, { linkId, amountCents: null, period: null, startsOn: null, userId }, timezone);
}

export type VoidRateResult = { ok: true } | { ok: false; error: "not_found" | "not_latest" | "stop_not_voidable" };

/**
 * Void a rent AMOUNT entered by mistake (a wrong amount, a wrong start date).
 *  - Only the LATEST entry, so nothing agreed after it can change, and the
 *    periods before its start keep their obligations.
 *  - Never a stop: a stop records the rent ending (leaving, removal, or the
 *    owner's choice). Voiding one would bill time with no agreement; rent
 *    starts again only by entering it, with a date.
 * The periods it covered go back to the entry before it (or to no rent). It
 * stays in the history, marked void with when. Voiding twice changes nothing.
 */
export async function voidRate(tx: Tx, linkId: string, rateId: string, userId: string): Promise<VoidRateResult> {
  await lockLink(tx, linkId);
  const row = await tx.boothRentRate.findFirst({
    where: { id: rateId, linkId },
    select: { id: true, voidedAt: true, amountCents: true },
  });
  if (!row) return { ok: false, error: "not_found" };
  if (row.voidedAt) return { ok: true };
  if (row.amountCents === null) return { ok: false, error: "stop_not_voidable" };
  if (effectiveRates(await rates(tx, linkId)).at(-1)?.id !== row.id) return { ok: false, error: "not_latest" };
  await tx.boothRentRate.update({ where: { id: row.id }, data: { voidedAt: new Date(), voidedById: userId } });
  return { ok: true };
}

export type RateStatus = "active" | "replaced" | "voided";

/**
 * Every rent entry, oldest first - the audit trail: the ones in effect, the
 * ones a same-day entry replaced (they come back if it's voided), and the
 * voided ones with the day they were voided.
 */
export async function rateHistory(tx: Tx, linkId: string) {
  const all = await tx.boothRentRate.findMany({
    where: { linkId },
    select: { id: true, amountCents: true, period: true, startsOn: true, createdAt: true, voidedAt: true },
  });
  const active = new Set(effectiveRates(all.filter((r) => !r.voidedAt)).map((r) => r.id));
  return [...all].sort(byStart).map((r) => ({
    id: r.id,
    amountCents: r.amountCents,
    period: r.period,
    startsOn: ymd(r.startsOn),
    status: (r.voidedAt ? "voided" : active.has(r.id) ? "active" : "replaced") as RateStatus,
    voidedOn: r.voidedAt ? ymd(r.voidedAt) : null,
  }));
}

/** Every payment, newest first, voided ones included and marked with when. */
export async function rentPayments(tx: Tx, linkId: string) {
  const rows = await tx.boothRentPayment.findMany({
    where: { linkId },
    orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }],
    take: 500,
    select: { id: true, amountCents: true, paidOn: true, method: true, note: true, voidedAt: true },
  });
  return rows.map(({ voidedAt, paidOn, ...r }) => ({
    ...r,
    paidOn: ymd(paidOn),
    voided: voidedAt !== null,
    voidedOn: voidedAt ? ymd(voidedAt) : null,
  }));
}

/** A link that has any rent record at all - an entry or a payment, voided or not. */
export const HAS_RENT_RECORDS = {
  OR: [{ rentRates: { some: {} } }, { rentPayments: { some: {} } }],
} satisfies Prisma.TeamLinkWhereInput;
