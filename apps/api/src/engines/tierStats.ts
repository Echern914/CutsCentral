import {
  averageTicketCents,
  tierStatWindows,
  type TierRules,
  type TierStats,
  type TierWindowDays,
} from "@chairback/config";
import type { Prisma } from "@chairback/db";
import { readChairEvents } from "./insightsWindow.js";

/**
 * The numbers a loyalty tier is decided on: completed visits and money earned,
 * per client, over exactly the windows a shop's rules ask about.
 *
 * 🔴 NEITHER NUMBER IS DEFINED HERE.
 *   - A visit is a COMPLETED Visit row - the predicate cadence.ts has always
 *     counted, so a shop on plain visit thresholds sees no change.
 *   - Money is `earnedCents` from readChairEvents(), the one revenue rule:
 *     real collected money net of refunds where the shop takes payment, the
 *     chair-side checkout figure where the barber closed it out, the ticket
 *     otherwise, and nothing for a no-show. A tier that counted money any other
 *     way would call someone a $300 client that the shop's own revenue page
 *     says spent $240.
 *   - An average ticket is those same per-row amounts, over COMPLETED rows
 *     whose amount is known - readChairEvents' `completedTickets` - divided
 *     by how many there are (averageTicketCents in config). Null when none.
 *
 * Windows are measured back from `now` in whole days (30 days, not "this
 * calendar month"), so a tier never flips at a month boundary for a client who
 * has not changed anything.
 *
 * Runs on the caller's shop-scoped transaction: Visit and Appointment are RLS
 * tables, and the recompute wants these reads and its writes to agree.
 */

const DAY_MS = 86_400_000;

/** Every window the rules name, at zero - a client with no history. */
export function zeroTierStats(rules: TierRules): TierStats {
  const w = tierStatWindows(rules);
  const stats: TierStats = { visits: {}, spendCents: {} };
  for (const d of w.visits) stats.visits[d] = 0;
  for (const d of w.spend) stats.spendCents[d] = 0;
  // No history is NO average - null, which no average-ticket rule counts as
  // met. Only present when the rules ask, so an old shop's numbers are as
  // they always were.
  if (w.avgTicket.length > 0) {
    stats.avgTicketCents = {};
    for (const d of w.avgTicket) stats.avgTicketCents[d] = null;
  }
  return stats;
}

export async function loadTierStats(
  tx: Prisma.TransactionClient,
  shopId: string,
  rules: TierRules,
  now: Date,
  clientId?: string,
): Promise<Map<string, TierStats>> {
  const windows = tierStatWindows(rules);
  const out = new Map<string, TierStats>();
  const statsFor = (id: string): TierStats => {
    let s = out.get(id);
    if (!s) {
      s = zeroTierStats(rules);
      out.set(id, s);
    }
    return s;
  };
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS);

  for (const days of windows.visits) {
    const groups = await tx.visit.groupBy({
      by: ["clientId"],
      where: {
        shopId,
        status: "COMPLETED",
        ...(clientId ? { clientId } : {}),
        ...(days > 0 ? { scheduledAt: { gte: since(days) } } : {}),
      },
      _count: { _all: true },
    });
    for (const g of groups) {
      if (g.clientId) statsFor(g.clientId).visits[days] = g._count._all;
    }
  }

  const moneyWindows = [...windows.spend, ...windows.avgTicket];
  if (moneyWindows.length > 0) {
    // One read covering the widest window - spend and average alike; each
    // row is then credited to every window it falls inside.
    const from = moneyWindows.includes(0) ? new Date(0) : since(Math.max(...moneyWindows));
    const { events, completedTickets } = await readChairEvents(shopId, from, now, {
      tx,
      ...(clientId ? { clientId } : {}),
    });
    const inWindow = (start: Date, days: number) => days === 0 || start.getTime() >= since(days).getTime();
    if (windows.spend.length > 0) {
      for (const e of events) {
        if (!e.clientId || e.earnedCents === 0) continue;
        const s = statsFor(e.clientId);
        for (const days of windows.spend) {
          if (inWindow(e.start, days)) {
            s.spendCents[days] = (s.spendCents[days] ?? 0) + e.earnedCents;
          }
        }
      }
    }
    if (windows.avgTicket.length > 0) {
      // AVERAGE TICKET: completed visits with a known amount only - the SAME
      // rows on both sides of the division (CompletedTicket says which). A $0
      // known amount (a fully refunded cut) IS a ticket and stays in.
      const amounts = new Map<string, Partial<Record<TierWindowDays, number[]>>>();
      for (const t of completedTickets) {
        if (!t.clientId) continue;
        let byWindow = amounts.get(t.clientId);
        if (!byWindow) {
          byWindow = {};
          amounts.set(t.clientId, byWindow);
        }
        for (const days of windows.avgTicket) {
          if (inWindow(t.start, days)) (byWindow[days] ??= []).push(t.cents);
        }
      }
      for (const [id, byWindow] of amounts) {
        const s = statsFor(id);
        for (const days of windows.avgTicket) {
          s.avgTicketCents![days] = averageTicketCents(byWindow[days] ?? []);
        }
      }
    }
  }
  return out;
}

/** One client's numbers. */
export async function loadClientTierStats(
  tx: Prisma.TransactionClient,
  shopId: string,
  clientId: string,
  rules: TierRules,
  now: Date,
): Promise<TierStats> {
  const all = await loadTierStats(tx, shopId, rules, now, clientId);
  return all.get(clientId) ?? zeroTierStats(rules);
}
