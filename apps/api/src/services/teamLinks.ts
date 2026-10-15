import { runAsOwner, runWithShop, type Prisma } from "@chairback/db";
import {
  bucketIndexFor,
  readChairEvents,
  resolvePeriodWindow,
  shopLocalDay,
  type ResolvedPeriod,
} from "../engines/insightsWindow.js";

/**
 * Independent businesses on a shop's team: the numbers a member lets the
 * team's owner see.
 *
 * 🔴 PRIVACY IS DECIDED HERE, NOT IN THE PAGE. A number the member hasn't
 * shared never leaves this function: the team gets `null`, which the page
 * shows as "Hidden". With nothing shared, nothing is read at all, and the
 * rating query runs only when rating is shared. Cuts, revenue and clients come
 * from ONE read of the member's bookings when any of them is shared, and only
 * the shared ones are kept - nothing else is logged or cached.
 *
 * 🔴 SAME NUMBERS AS THE MEMBER'S OWN INSIGHTS. Cuts, revenue and clients use
 * the Insights "Last 30 days" window (the member's own timezone and days) and
 * its counting rules, so the owner's table can never disagree with what the
 * barber sees on their own Insights page. teamLinks.test.ts compares them.
 */

export const SHARE_KEYS = ["shareCuts", "shareRevenue", "shareClients", "shareRating"] as const;
export type ShareKey = (typeof SHARE_KEYS)[number];
export type Sharing = Record<ShareKey, boolean>;

export const NOTHING_SHARED: Sharing = {
  shareCuts: false,
  shareRevenue: false,
  shareClients: false,
  shareRating: false,
};

/**
 * Everything a member can share on a LINK, off: the four numbers and their
 * schedule. What a link is reset to when it ends or starts over. (A mentor
 * pairing shares numbers only - it uses NOTHING_SHARED.)
 */
export const LINK_NOTHING_SHARED = { ...NOTHING_SHARED, shareSchedule: false } as const;

export function sharingOf(link: Sharing): Sharing {
  return {
    shareCuts: link.shareCuts,
    shareRevenue: link.shareRevenue,
    shareClients: link.shareClients,
    shareRating: link.shareRating,
  };
}

/**
 * The windows the owner can pick, each one an Insights preset - so a member's
 * numbers here are the ones on their own Insights page for the same window.
 */
export const TEAM_PERIODS = ["7d", "30d", "90d"] as const;
export type TeamPeriod = (typeof TEAM_PERIODS)[number];
export const DEFAULT_TEAM_PERIOD: TeamPeriod = "30d";
export function teamPeriodOf(raw: unknown): TeamPeriod {
  return (TEAM_PERIODS as readonly unknown[]).includes(raw) ? (raw as TeamPeriod) : DEFAULT_TEAM_PERIOD;
}

/** The counted numbers for one window. `null` = not shared. */
export interface WindowNumbers {
  cuts: number | null;
  revenueCents: number | null;
  clients: number | null;
}

/** What the team's owner sees for one member. `null` = not shared. */
export interface TeamNumbers extends WindowNumbers {
  /** Every approved rating, all time - the stars on their public page. */
  rating: { average: number | null; count: number } | null;
  /**
   * The same counts for the window just before, of the same length - what
   * "up 18%" is measured against. Null exactly where the current one is.
   */
  previous: WindowNumbers;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The window just before `period`, the same length: the 7 days before the last
 * 7, the 30 before the last 30, the 13 weeks before the last 13 weeks. Built by
 * resolving the same preset from a `now` one window earlier, so its edges are
 * shop-local days (and Mon-start weeks) exactly like the current window's.
 */
function previousWindow(now: Date, timezone: string, key: TeamPeriod, current: ResolvedPeriod): ResolvedPeriod {
  const lengthMs = current.buckets[current.buckets.length - 1]!.end.getTime() - current.windowStart.getTime();
  return resolvePeriodWindow(new Date(now.getTime() - lengthMs), timezone, key);
}

export async function teamNumbers(
  member: { id: string; timezone: string },
  sharing: Sharing,
  now: Date = new Date(),
  key: TeamPeriod = DEFAULT_TEAM_PERIOD,
): Promise<TeamNumbers> {
  const out: TeamNumbers = {
    cuts: null,
    revenueCents: null,
    clients: null,
    rating: null,
    previous: { cuts: null, revenueCents: null, clients: null },
  };
  const needEvents = sharing.shareCuts || sharing.shareRevenue || sharing.shareClients;
  if (!needEvents && !sharing.shareRating) return out;

  await runWithShop(member.id, async (tx) => {
    if (needEvents) {
      // Exactly the Insights read: the window in the member's own days,
      // fetched with a day of padding each side and trimmed by bucket - ONE
      // read covering this window and the one before it.
      const period = resolvePeriodWindow(now, member.timezone, key);
      const before = previousWindow(now, member.timezone, key, period);
      const { events } = await readChairEvents(
        member.id,
        new Date(before.windowStart.getTime() - DAY_MS),
        new Date(period.today.getTime() + 2 * DAY_MS),
        { tx },
      );
      const count = (win: ResolvedPeriod): WindowNumbers => {
        let visits = 0;
        let earnedCents = 0;
        const clients = new Set<string>();
        for (const e of events) {
          if (e.start > now) continue;
          if (bucketIndexFor(win, shopLocalDay(e.start, member.timezone)) < 0) continue;
          visits++;
          earnedCents += e.earnedCents;
          if (e.clientId) clients.add(e.clientId);
        }
        return {
          cuts: sharing.shareCuts ? visits : null,
          revenueCents: sharing.shareRevenue ? earnedCents : null,
          clients: sharing.shareClients ? clients.size : null,
        };
      };
      Object.assign(out, count(period));
      out.previous = count(before);
    }
    if (sharing.shareRating) {
      const agg = await tx.review.aggregate({
        where: { shopId: member.id, status: "APPROVED" },
        _avg: { rating: true },
        _count: true,
      });
      out.rating = { average: agg._avg.rating ?? null, count: agg._count };
    }
  });
  return out;
}

/** One metric across the team: summed over the members who share it. */
export interface TeamTotal {
  /** Null when nobody shares it. */
  value: number | null;
  /** The same members' total for the window before. */
  previous: number | null;
  /** How many members' numbers are in it, of how many on the team. */
  sharedBy: number;
  of: number;
}

/**
 * The team's totals, from what members share - never more. A member who hides
 * revenue is simply not in the revenue total, and the total says "from 3 of 4"
 * so it is never read as the whole team's. The previous-window figure sums the
 * SAME members, so the change compares like with like.
 */
export function teamTotals(members: { numbers: TeamNumbers }[]): {
  cuts: TeamTotal;
  revenueCents: TeamTotal;
  clients: TeamTotal;
} {
  const total = (pick: (n: WindowNumbers) => number | null): TeamTotal => {
    let value = 0;
    let previous = 0;
    let sharedBy = 0;
    for (const m of members) {
      const v = pick(m.numbers);
      if (v === null) continue;
      sharedBy++;
      value += v;
      previous += pick(m.numbers.previous) ?? 0;
    }
    return sharedBy === 0
      ? { value: null, previous: null, sharedBy: 0, of: members.length }
      : { value, previous, sharedBy, of: members.length };
  };
  return {
    cuts: total((n) => n.cuts),
    revenueCents: total((n) => n.revenueCents),
    clients: total((n) => n.clients),
  };
}

/* ------------------------------ activity ------------------------------ */

export type TeamEventKind =
  | "requested"
  | "approved"
  | "declined"
  | "removed"
  | "left"
  | "withdrew"
  | "shared"
  | "hid"
  // A member who shares their schedule changed their hours or time off.
  | "availability";

/** What a "shared"/"hid" line names: one of the four numbers, or the schedule. */
export type TeamMetric = "cuts" | "revenue" | "clients" | "rating" | "schedule";

/** The metric name a share switch is logged under. */
export const METRIC_OF: Record<ShareKey, "cuts" | "revenue" | "clients" | "rating"> = {
  shareCuts: "cuts",
  shareRevenue: "revenue",
  shareClients: "clients",
  shareRating: "rating",
};

/** Record one thing that happened on a link, in the caller's transaction. */
export async function recordTeamEvent(
  tx: Prisma.TransactionClient,
  link: { id: string; teamShopId: string },
  kind: TeamEventKind,
  metric: TeamMetric | null = null,
): Promise<void> {
  await tx.teamLinkEvent.create({
    data: { linkId: link.id, teamShopId: link.teamShopId, kind, metric },
  });
}

/** One share switch per changed key: "shared revenue", "hid clients". */
export async function recordSharingChanges(
  tx: Prisma.TransactionClient,
  link: { id: string; teamShopId: string },
  before: Sharing,
  after: Sharing,
) {
  for (const key of SHARE_KEYS) {
    if (before[key] === after[key]) continue;
    await recordTeamEvent(tx, link, after[key] ? "shared" : "hid", METRIC_OF[key]);
  }
}

export interface TeamActivityItem {
  id: string;
  at: string;
  business: string;
  kind: TeamEventKind | "rent_paid";
  metric: string | null;
  /** rent_paid only: what the owner recorded. */
  amountCents: number | null;
  method: string | null;
}

/**
 * The team owner's feed: link events plus the rent payments they recorded,
 * newest first. A voided payment is left out - it is a correction, and the
 * rent card shows it. Nothing here carries a member's numbers.
 */
export async function teamActivity(teamShopId: string, limit = 30): Promise<TeamActivityItem[]> {
  return runAsOwner(async (tx) => {
    const [events, payments] = await Promise.all([
      tx.teamLinkEvent.findMany({
        where: { teamShopId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          kind: true,
          metric: true,
          createdAt: true,
          link: { select: { memberShop: { select: { name: true } } } },
        },
      }),
      tx.boothRentPayment.findMany({
        where: { voidedAt: null, link: { teamShopId } },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          amountCents: true,
          method: true,
          createdAt: true,
          link: { select: { memberShop: { select: { name: true } } } },
        },
      }),
    ]);
    const items: TeamActivityItem[] = [
      ...events.map((e) => ({
        id: `e:${e.id}`,
        at: e.createdAt.toISOString(),
        business: e.link.memberShop.name,
        kind: e.kind as TeamEventKind,
        metric: e.metric,
        amountCents: null,
        method: null,
      })),
      ...payments.map((p) => ({
        id: `p:${p.id}`,
        at: p.createdAt.toISOString(),
        business: p.link.memberShop.name,
        kind: "rent_paid" as const,
        metric: null,
        amountCents: p.amountCents,
        method: p.method,
      })),
    ];
    return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
  });
}

/** The fields a page needs about the other side of a link. */
const SHOP_CARD = { id: true, name: true, slug: true, timezone: true, logoUrl: true } as const;

/** Links where `shopId` is the TEAM (the owner's view). Never includes ENDED. */
export function linksForTeam(shopId: string) {
  return runAsOwner((tx) =>
    tx.teamLink.findMany({
      where: { teamShopId: shopId, status: { in: ["PENDING", "ACTIVE"] } },
      orderBy: [{ status: "asc" }, { requestedAt: "asc" }],
      include: {
        memberShop: {
          select: { ...SHOP_CARD, owner: { select: { name: true, email: true } } },
        },
      },
    }),
  );
}

/** Links where `shopId` is the MEMBER (the barber's own view). */
export function linksForMember(shopId: string) {
  return runAsOwner((tx) =>
    tx.teamLink.findMany({
      where: { memberShopId: shopId, status: { in: ["PENDING", "ACTIVE"] } },
      orderBy: { requestedAt: "asc" },
      include: { teamShop: { select: SHOP_CARD } },
    }),
  );
}
