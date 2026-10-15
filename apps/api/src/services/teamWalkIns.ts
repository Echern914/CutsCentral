import { prisma, runAsOwner, type Shop } from "@chairback/db";
import { hasActiveAccess } from "../billing/stripe.js";
import { PUBLIC_SERVICE } from "../engines/serviceVisibility.js";
import { activeQueueForEstimate, estimateForNewEntry } from "../engines/walkInCheckIn.js";
import { estimateQueue } from "../engines/walkInEstimate.js";
import { ACTIVE_STATUSES, QUEUE_ORDER } from "../engines/walkInLifecycle.js";

/**
 * TEAM WALK-INS: one front desk for a shop of independent businesses.
 *
 * The desk is the TEAM shop's kiosk. A customer checks in there, picks who
 * they're here for - or "next available" - and joins THAT business's own
 * line: the entry is created in the member's shop, on the member's books,
 * exactly as if they had used the member's own kiosk. The member runs it from
 * their own Walk-ins board; the team's owner sees the desk's line, read-only.
 *
 * WHO THE DESK OFFERS ("businesses"): the team shop's own chairs, when it has
 * any, plus every member who
 *   - is on the team (ACTIVE link) and switched on "take walk-ins from the
 *     front desk" (TeamLink.takeTeamWalkIns - the MEMBER's switch), and
 *   - can take one right now: their own walk-in line on and not paused, an
 *     active subscription, a public service and an active chair.
 * A member who can't is simply not offered - a customer is never shown a
 * barber they can't join.
 *
 * 🔴 The desk never reads a member's clients, numbers or schedule beyond
 * what their own kiosk would show a customer at their own door: name, logo,
 * public services, chairs, and a wait estimate.
 */

/** The team shop's own chairs, as a desk choice. Every other id is a TeamLink id. */
export const OWN_DESK = "own";

/** Why a business isn't offered at the desk, for the owner's and member's pages. */
export type DeskReason = "not_taking" | "line_off" | "paused" | "no_access" | "no_services" | "no_staff";

/** Can this shop take a walk-in right now? null = yes. */
export async function deskReadiness(shop: Shop): Promise<DeskReason | null> {
  if (!shop.walkInEnabled) return "line_off";
  if (!shop.walkInAcceptingNow) return "paused";
  if (!hasActiveAccess(shop)) return "no_access";
  const [services, staff] = await Promise.all([
    prisma.service.count({ where: { shopId: shop.id, ...PUBLIC_SERVICE } }),
    prisma.staff.count({ where: { shopId: shop.id, active: true } }),
  ]);
  if (services === 0) return "no_services";
  if (staff === 0) return "no_staff";
  return null;
}

/** The ACTIVE links on this team whose member takes front-desk walk-ins. */
export function takingLinks(teamShopId: string) {
  return runAsOwner((tx) =>
    tx.teamLink.findMany({
      where: { teamShopId, status: "ACTIVE", takeTeamWalkIns: true },
      orderBy: { approvedAt: "asc" },
      select: { id: true, memberShopId: true },
    }),
  );
}

/** Is this shop a front desk at all - does any member take its walk-ins? */
export async function isFrontDesk(teamShopId: string): Promise<boolean> {
  return (await takingLinks(teamShopId)).length > 0;
}

export interface DeskBusiness {
  /** OWN_DESK or the member's TeamLink id - never a shop id. */
  id: string;
  shop: Shop;
}

/**
 * Who the desk can send a walk-in to RIGHT NOW, in a stable order: the team's
 * own chairs first, then members in the order they joined.
 */
export async function deskBusinesses(team: Shop): Promise<DeskBusiness[]> {
  const out: DeskBusiness[] = [];
  if ((await deskReadiness(team)) === null) out.push({ id: OWN_DESK, shop: team });
  const links = await takingLinks(team.id);
  if (links.length === 0) return out;
  const shops = await prisma.shop.findMany({ where: { id: { in: links.map((l) => l.memberShopId) } } });
  for (const link of links) {
    const shop = shops.find((s) => s.id === link.memberShopId);
    if (shop && (await deskReadiness(shop)) === null) out.push({ id: link.id, shop });
  }
  return out;
}

/**
 * The shop a desk choice sends the customer to, re-checked at the moment of
 * use: a member who switched off, left, or paused their line a second ago is
 * no longer a valid choice. Null = not a choice this desk can make now.
 * A missing choice is the team's own chairs (an older kiosk screen).
 */
export async function deskTarget(team: Shop, businessId: string | null | undefined): Promise<Shop | null> {
  if (!businessId || businessId === OWN_DESK) return team;
  const link = await runAsOwner((tx) =>
    tx.teamLink.findFirst({
      where: { id: businessId, teamShopId: team.id, status: "ACTIVE", takeTeamWalkIns: true },
      select: { memberShopId: true },
    }),
  );
  if (!link) return null;
  const shop = await prisma.shop.findUnique({ where: { id: link.memberShopId } });
  if (!shop || (await deskReadiness(shop)) !== null) return null;
  return shop;
}

/** What the kiosk shows for one business: the same public facts its own kiosk shows. */
export async function deskMenu(shopId: string) {
  const [services, staff, offerings] = await Promise.all([
    prisma.service.findMany({
      where: { shopId, ...PUBLIC_SERVICE },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, description: true, durationMin: true, price: true, color: true },
    }),
    prisma.staff.findMany({
      where: { shopId, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, imageUrl: true },
    }),
    prisma.serviceStaff.findMany({ where: { shopId }, select: { serviceId: true, staffId: true } }),
  ]);
  return {
    services: services.map((s) => ({ ...s, price: s.price === null ? null : Number(s.price) })),
    staff,
    offerings,
  };
}

/**
 * Each business's wait for its FIRST service (the one at the top of its
 * menu) - "about how long for a cut with Chris". The same engine as every
 * other walk-in quote; the exact wait for what they pick comes at review.
 */
export async function deskWaits(
  businesses: DeskBusiness[],
  now: Date,
): Promise<{ id: string; waitMin: number | null; ahead: number }[]> {
  const out: { id: string; waitMin: number | null; ahead: number }[] = [];
  for (const b of businesses) {
    const first = await prisma.service.findFirst({
      where: { shopId: b.shop.id, ...PUBLIC_SERVICE },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, durationMin: true },
    });
    if (!first) {
      out.push({ id: b.id, waitMin: null, ahead: 0 });
      continue;
    }
    const est = await estimateForNewEntry({
      shopId: b.shop.id,
      now,
      totalDurationMin: first.durationMin,
      serviceIds: [first.id],
      preferredStaffId: null,
    });
    out.push({ id: b.id, waitMin: est.waitMin, ahead: est.ahead });
  }
  return out;
}

/* ------------------------------ the owner's view ------------------------------ */

export interface DeskLineEntry {
  id: string;
  business: { name: string };
  firstName: string;
  status: string;
  /** Minutes until they're expected in the chair; null = no estimate. */
  waitMin: number | null;
  joinedAt: string;
}

/**
 * The desk's line: everyone checked in at THIS desk who is still waiting or
 * in a chair, across the businesses they joined, with each one's wait from
 * their own line's estimate. First name only - no phone, no last name, no
 * services: the owner sees who is in the shop and for whom, nothing more.
 */
export async function deskLine(teamShopId: string, now: Date = new Date()): Promise<DeskLineEntry[]> {
  const entries = await prisma.walkInEntry.findMany({
    where: { viaTeamShopId: teamShopId, status: { in: [...ACTIVE_STATUSES] } },
    orderBy: [...QUEUE_ORDER],
    select: {
      id: true,
      shopId: true,
      firstName: true,
      status: true,
      joinedAt: true,
      shop: { select: { name: true } },
    },
  });
  const waits = new Map<string, number | null>();
  for (const shopId of new Set(entries.map((e) => e.shopId))) {
    const est = await estimateQueue({ shopId, now, queue: await activeQueueForEstimate(shopId) });
    for (const [id, q] of est) waits.set(id, q.waitMin);
  }
  return entries
    .map((e) => ({
      id: e.id,
      business: { name: e.shop.name },
      firstName: e.firstName,
      status: e.status,
      waitMin: waits.get(e.id) ?? null,
      joinedAt: e.joinedAt.toISOString(),
    }))
    .sort((a, b) => (a.joinedAt < b.joinedAt ? -1 : a.joinedAt > b.joinedAt ? 1 : a.id < b.id ? -1 : 1));
}

/** Why each member is or isn't at the desk, for the owner's page. */
export async function deskMembers(
  teamShopId: string,
): Promise<{ linkId: string; business: { name: string }; taking: boolean; reason: DeskReason | null }[]> {
  const links = await runAsOwner((tx) =>
    tx.teamLink.findMany({
      where: { teamShopId, status: "ACTIVE" },
      orderBy: { approvedAt: "asc" },
      select: { id: true, takeTeamWalkIns: true, memberShopId: true },
    }),
  );
  const shops = await prisma.shop.findMany({ where: { id: { in: links.map((l) => l.memberShopId) } } });
  const out = [];
  for (const l of links) {
    const shop = shops.find((s) => s.id === l.memberShopId);
    if (!shop) continue;
    out.push({
      linkId: l.id,
      business: { name: shop.name },
      taking: l.takeTeamWalkIns,
      reason: l.takeTeamWalkIns ? await deskReadiness(shop) : ("not_taking" as const),
    });
  }
  return out;
}
