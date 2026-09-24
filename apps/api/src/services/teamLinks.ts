import { runAsOwner, runWithShop } from "@chairback/db";
import {
  bucketIndexFor,
  readChairEvents,
  resolvePeriodWindow,
  shopLocalDay,
} from "../engines/insightsWindow.js";

/**
 * Independent businesses on a shop's team: the numbers a member lets the
 * team's owner see.
 *
 * 🔴 PRIVACY IS DECIDED HERE, NOT IN THE PAGE. A number the member hasn't
 * shared is never computed - not computed and then hidden - so it cannot leak
 * through a payload, a log line or a cache. The team gets `null`, which the
 * page shows as "Hidden".
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

export function sharingOf(link: Sharing): Sharing {
  return {
    shareCuts: link.shareCuts,
    shareRevenue: link.shareRevenue,
    shareClients: link.shareClients,
    shareRating: link.shareRating,
  };
}

/** What the team's owner sees for one member. `null` = not shared. */
export interface TeamNumbers {
  /** Visits in the last 30 days - Insights' "visits" total. */
  cuts: number | null;
  /** Money earned in the last 30 days, integer cents - Insights' revenue. */
  revenueCents: number | null;
  /** Distinct clients seen in the last 30 days - Insights' unique clients. */
  clients: number | null;
  /** Every approved rating, all time - the stars on their public page. */
  rating: { average: number | null; count: number } | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function teamNumbers(
  member: { id: string; timezone: string },
  sharing: Sharing,
  now: Date = new Date(),
): Promise<TeamNumbers> {
  const out: TeamNumbers = { cuts: null, revenueCents: null, clients: null, rating: null };
  const needEvents = sharing.shareCuts || sharing.shareRevenue || sharing.shareClients;
  if (!needEvents && !sharing.shareRating) return out;

  await runWithShop(member.id, async (tx) => {
    if (needEvents) {
      // Exactly the Insights read: the 30-day window in the member's own
      // days, fetched with a day of padding each side and trimmed by bucket.
      const period = resolvePeriodWindow(now, member.timezone, "30d");
      const { events } = await readChairEvents(
        member.id,
        new Date(period.windowStart.getTime() - DAY_MS),
        new Date(period.today.getTime() + 2 * DAY_MS),
        { tx },
      );
      let visits = 0;
      let earnedCents = 0;
      const clients = new Set<string>();
      for (const e of events) {
        if (e.start > now) continue;
        if (bucketIndexFor(period, shopLocalDay(e.start, member.timezone)) < 0) continue;
        visits++;
        earnedCents += e.earnedCents;
        if (e.clientId) clients.add(e.clientId);
      }
      if (sharing.shareCuts) out.cuts = visits;
      if (sharing.shareRevenue) out.revenueCents = earnedCents;
      if (sharing.shareClients) out.clients = clients.size;
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
