import type { Prisma } from "@chairback/db";
import {
  DAY_MS,
  bucketIndexFor,
  readChairEvents,
  shopLocalDay,
  type ChairEvent,
  type ResolvedPeriod,
} from "./insightsWindow.js";
import {
  appointmentTipSnapshot,
  stripeCollectedCents,
  type PaymentRowFacts,
} from "./appointmentPayment.js";

/**
 * WHO DID THE WORK: one shop's numbers, split by the person who took the
 * appointment.
 *
 * ── 🔴 NOT A SECOND REVENUE RULE ─────────────────────────────────────────────
 *
 * `readChairEvents()` owns what an appointment earned. This file only decides
 * which pile each event lands in, and it is the ONE place that decides it: the
 * Insights page, the assistant's business summary and a team member's own
 * numbers all add events up through `chairTally()`. Three surfaces that split
 * the same money three ways would be three chances for an owner and their
 * staff to be looking at different figures for the same week.
 *
 * ── 🔴 EVERY PILE SUMS TO THE SHOP ───────────────────────────────────────────
 *
 * A booking synced from Acuity or Square records no one against it
 * (`ChairEvent.staffId` is null). Those land in `unassigned`, never dropped
 * and never spread across people: the rows have to add up to the total the
 * owner already sees, and a guess presented as a fact is worse than a row
 * that says "not assigned".
 */

export interface WorkTally {
  /** Appointments that happened, no-shows included (the Insights "visits" tile). */
  cuts: number;
  noShows: number;
  /** Dollars, as `ChairEvent.earned` carries them. */
  earned: number;
  earnedCents: number;
}

export const emptyTally = (): WorkTally => ({ cuts: 0, noShows: 0, earned: 0, earnedCents: 0 });

export function addToTally(t: WorkTally, e: ChairEvent): void {
  t.cuts += 1;
  if (e.noShow) t.noShows += 1;
  t.earned += e.earned;
  t.earnedCents += e.earnedCents;
}

export interface ChairTally {
  shop: WorkTally;
  /** Synced work, which records nobody against it. */
  unassigned: WorkTally;
  byChair: Map<string, WorkTally>;
  /** Count one event. The CALLER decides whether it is in the window. */
  add(e: ChairEvent): void;
}

export function chairTally(): ChairTally {
  const shop = emptyTally();
  const unassigned = emptyTally();
  const byChair = new Map<string, WorkTally>();
  return {
    shop,
    unassigned,
    byChair,
    add(e) {
      addToTally(shop, e);
      if (!e.staffId) {
        addToTally(unassigned, e);
        return;
      }
      const t = byChair.get(e.staffId) ?? emptyTally();
      addToTally(t, e);
      byChair.set(e.staffId, t);
    },
  };
}

/**
 * "Has this already happened, inside this window?" - the Insights page's own
 * test, in one place: an appointment still ahead is capacity, not takings, and
 * a row read as padding either side of the window is not the window.
 */
export function happenedInWindow(
  period: ResolvedPeriod,
  timezone: string,
  now: Date,
): (at: Date) => boolean {
  return (at) => at <= now && bucketIndexFor(period, shopLocalDay(at, timezone)) >= 0;
}

/**
 * Real instants for the database filter: a day of padding each side, so a
 * shop-local day that straddles UTC midnight is never clipped. The padding is
 * dropped again by `happenedInWindow`.
 */
export function paddedRange(period: ResolvedPeriod): { from: Date; to: Date } {
  return {
    from: new Date(period.windowStart.getTime() - DAY_MS),
    to: new Date(period.today.getTime() + 2 * DAY_MS),
  };
}

export interface VisitTip {
  /** The visit's start - a tip is filed under the visit it was left for. */
  start: Date;
  cents: number;
  /** Who took the appointment the tip was left on. */
  staffId: string;
}

/**
 * Tips, by the visit they were left on: the online tip (what Stripe settled,
 * net of refunds) plus a cash / other-app tip recorded on the appointment's
 * Tip row. Both go through `appointmentTipSnapshot` - the one place a visit's
 * tips are added - so no card can disagree with the appointment itself.
 *
 * Tips stay OUT of revenue. Only native appointments can carry one, so every
 * tip has a person against it.
 */
export async function readVisitTips(
  tx: Prisma.TransactionClient,
  shopId: string,
  from: Date,
  to: Date,
  opts: { staffId?: string } = {},
): Promise<VisitTip[]> {
  const rows = await tx.appointment.findMany({
    where: {
      shopId,
      ...(opts.staffId ? { staffId: opts.staffId } : {}),
      startsAt: { gte: from, lt: to },
      OR: [{ recordedTipCents: { not: null } }, { payments: { some: { purpose: "tip" } } }],
    },
    select: {
      startsAt: true,
      staffId: true,
      recordedTipCents: true,
      recordedTipMethod: true,
      payments: {
        where: { purpose: "tip" },
        select: { status: true, amount: true, capturedAmount: true, refundedAmount: true },
      },
    },
  });
  // At most one LIVE tip per visit (Payment_appointmentId_tip_live_key); a
  // failed attempt beside it collects nothing, so the live one is the one
  // that collected the most.
  const liveTip = (payments: PaymentRowFacts[]) =>
    payments.reduce<PaymentRowFacts | null>(
      (best, p) => (best === null || stripeCollectedCents(p) > stripeCollectedCents(best) ? p : best),
      null,
    );
  return rows
    .map((a) => ({
      start: a.startsAt,
      staffId: a.staffId,
      cents: appointmentTipSnapshot({
        online: liveTip(a.payments),
        recorded:
          a.recordedTipCents !== null && a.recordedTipMethod !== null
            ? { cents: a.recordedTipCents, method: a.recordedTipMethod }
            : null,
      }).totalCents,
    }))
    .filter((t) => t.cents > 0);
}

export interface ChairReportRow {
  staffId: string;
  name: string;
  /** False for someone taken off the booking page who still worked in this window. */
  active: boolean;
  visits: number;
  noShows: number;
  revenueCents: number;
  tipsCents: number;
}

export interface ChairReport {
  rows: ChairReportRow[];
  /** Synced work with nobody recorded against it; null when there is none. */
  notAssigned: { visits: number; noShows: number; revenueCents: number } | null;
  /** rows + notAssigned, which is the shop's own total for the window. */
  total: { visits: number; noShows: number; revenueCents: number; tipsCents: number };
}

/**
 * The rows an owner reads: everyone on the booking page (a zero is a finding,
 * not an omission), plus anyone since taken off it who worked in the window.
 */
export function buildChairReport(input: {
  staff: { id: string; name: string; active: boolean }[];
  tally: ChairTally;
  tips: VisitTip[];
}): ChairReport {
  const tipsBy = new Map<string, number>();
  for (const t of input.tips) tipsBy.set(t.staffId, (tipsBy.get(t.staffId) ?? 0) + t.cents);

  const known = new Set(input.staff.map((s) => s.id));
  const rows: ChairReportRow[] = [];
  for (const s of input.staff) {
    const t = input.tally.byChair.get(s.id);
    const tipsCents = tipsBy.get(s.id) ?? 0;
    if (!s.active && !t && tipsCents === 0) continue;
    rows.push({
      staffId: s.id,
      name: s.name,
      active: s.active,
      visits: t?.cuts ?? 0,
      noShows: t?.noShows ?? 0,
      revenueCents: t?.earnedCents ?? 0,
      tipsCents,
    });
  }

  // Work against a person this list does not hold cannot be named, but it must
  // still be counted: the rows have to add up to the shop.
  const rest = { ...input.tally.unassigned };
  for (const [staffId, t] of input.tally.byChair) {
    if (known.has(staffId)) continue;
    rest.cuts += t.cuts;
    rest.noShows += t.noShows;
    rest.earnedCents += t.earnedCents;
  }

  return {
    rows,
    notAssigned:
      rest.cuts > 0 ? { visits: rest.cuts, noShows: rest.noShows, revenueCents: rest.earnedCents } : null,
    total: {
      visits: input.tally.shop.cuts,
      noShows: input.tally.shop.noShows,
      revenueCents: input.tally.shop.earnedCents,
      tipsCents: input.tips.reduce((sum, t) => sum + t.cents, 0),
    },
  };
}

/**
 * ONE person's numbers for a window, read on their id alone.
 *
 * The caller passes the id of the person the signed-in seat is linked to -
 * never one a client sent. Both reads are filtered to that id in the database,
 * so a colleague's appointment is not in memory to leak, and synced work
 * (which records nobody) is not read at all.
 */
export async function readOwnChairNumbers(
  tx: Prisma.TransactionClient,
  input: { shopId: string; timezone: string; staffId: string; period: ResolvedPeriod; now: Date },
): Promise<{ visits: number; noShows: number; revenueCents: number; tipsCents: number }> {
  const { from, to } = paddedRange(input.period);
  const counts = happenedInWindow(input.period, input.timezone, input.now);
  const { events } = await readChairEvents(input.shopId, from, to, { staffId: input.staffId, tx });
  const mine = emptyTally();
  for (const e of events) {
    // 🔴 The database already filtered to this person. Checked again here so a
    // change to that read can never widen what one person is shown.
    if (e.staffId !== input.staffId) continue;
    if (counts(e.start)) addToTally(mine, e);
  }
  const tips = await readVisitTips(tx, input.shopId, from, to, { staffId: input.staffId });
  let tipsCents = 0;
  for (const t of tips) {
    if (t.staffId === input.staffId && counts(t.start)) tipsCents += t.cents;
  }
  return { visits: mine.cuts, noShows: mine.noShows, revenueCents: mine.earnedCents, tipsCents };
}
