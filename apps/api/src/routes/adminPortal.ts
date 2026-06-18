import { Router } from "express";
import { z } from "zod";
import { BILLING } from "@chairback/config";
import { prisma } from "@chairback/db";
import { requireUser } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import { ACTIVE_STATUSES, billingEnabled, hasActiveAccess } from "../billing/stripe.js";

/**
 * Operator portal API (the founder's own admin surface). Session-gated to
 * isAdmin users only - distinct from the ADMIN_TOKEN cron endpoints in
 * admin.ts. Read-only metrics + the one write the operator needs day to day:
 * comping a shop to free full access.
 */
export const adminPortalRouter: Router = Router();
adminPortalRouter.use(requireUser, requireAdmin);

const MS_PER_DAY = 86_400_000;

// Topline metrics for the dashboard cards.
adminPortalRouter.get("/metrics", async (_req, res) => {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * MS_PER_DAY);

  const [totalShops, newThisWeek, statusGroups, compCount, totalClients, totalVisits] =
    await Promise.all([
      prisma.shop.count(),
      prisma.shop.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.shop.groupBy({ by: ["subscriptionStatus"], _count: { _all: true } }),
      prisma.shop.count({ where: { compAccess: true } }),
      prisma.client.count(),
      prisma.visit.count(),
    ]);

  const byStatus = new Map(statusGroups.map((g) => [g.subscriptionStatus, g._count._all]));
  const paying = (byStatus.get("active") ?? 0) + (byStatus.get("past_due") ?? 0);
  const trialing = byStatus.get("trialing") ?? 0;
  // Only true paying subscriptions count toward MRR - comps are revenue-neutral.
  const mrrEstimate = paying * BILLING.priceMonthlyUsd;

  res.json({
    billingEnabled: billingEnabled(),
    priceMonthlyUsd: BILLING.priceMonthlyUsd,
    totalShops,
    newThisWeek,
    paying,
    trialing,
    comped: compCount,
    mrrEstimate,
    totalClients,
    totalVisits,
  });
});

// Every shop, newest first, with the operator-relevant fields. Optional ?q=
// filters by shop name or owner email.
adminPortalRouter.get("/shops", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const where = q
    ? {
        OR: [
          { name: { contains: q, mode: "insensitive" as const } },
          { owner: { email: { contains: q, mode: "insensitive" as const } } },
        ],
      }
    : {};
  const shops = await prisma.shop.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      owner: { select: { email: true, name: true } },
      _count: { select: { clients: true, visits: true } },
    },
  });

  res.json({
    shops: shops.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      industry: s.industry,
      ownerEmail: s.owner.email,
      ownerName: s.owner.name,
      plan: s.plan,
      subscriptionStatus: s.subscriptionStatus,
      compAccess: s.compAccess,
      subscribed:
        Boolean(s.stripeSubscriptionId) && ACTIVE_STATUSES.has(s.subscriptionStatus),
      hasAccess: hasActiveAccess(s),
      trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
      clientCount: s._count.clients,
      visitCount: s._count.visits,
      createdAt: s.createdAt.toISOString(),
    })),
  });
});

// Platform-wide usage analytics (the founder's "what's actually happening"
// tracker). Cross-shop aggregates - runs as the raw `prisma` owner role, so it
// sees every tenant's rows (the admin gate above is the only access control).
// ?days= sets the window for the time-series + engagement counts (7..365,
// default 30); the top lists count over that same window.
adminPortalRouter.get("/analytics", async (req, res) => {
  const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));
  const now = new Date();
  const since = new Date(now.getTime() - days * MS_PER_DAY);

  const [
    completedVisits,
    serviceGroups,
    redemptionRows,
    promoUses,
    nudgeGroups,
    nudgeBookings,
  ] = await Promise.all([
    // Time series + total: completed visits keyed by completedAt within window.
    prisma.visit.findMany({
      where: { status: "COMPLETED", completedAt: { gte: since } },
      select: { completedAt: true },
    }),
    // Top services across all completed visits in window. serviceName is free
    // text from Acuity (or null for manual visits), grouped as-is.
    prisma.visit.groupBy({
      by: ["serviceName"],
      where: { status: "COMPLETED", completedAt: { gte: since } },
      _count: { _all: true },
    }),
    // Reward redemptions: real redemptions still standing. note carries the
    // reward name even after the Reward row is deleted (rewardId -> null).
    //  - reversalOfId: null  excludes CORRECTION rows (undoing an earn/bonus
    //    writes an offsetting punchesRedeemed > 0 row with an "undo:"/"edit:"
    //    note that would otherwise inflate the total).
    //  - reversedAt: null    excludes redemptions the barber later undid (the
    //    redemption didn't ultimately happen).
    prisma.punchLedger.findMany({
      where: {
        punchesRedeemed: { gt: 0 },
        createdAt: { gte: since },
        reversalOfId: null,
        reversedAt: null,
      },
      select: { note: true },
    }),
    // Promo redemptions recorded at the chair.
    prisma.promotionRedemption.count({ where: { redeemedAt: { gte: since } } }),
    // SMS outcomes by status (SENT/FAILED/SKIPPED/PENDING) in window.
    prisma.nudge.groupBy({
      by: ["status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    // Texts that led to a rebooking (attribution) in window.
    prisma.nudge.count({
      where: { createdAt: { gte: since }, resultedInBookingAt: { not: null } },
    }),
  ]);

  // Bucket completed visits into local-ish daily counts (UTC day key). The web
  // layer renders the labels; here we just emit a dense YYYY-MM-DD -> count map.
  const byDay = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * MS_PER_DAY);
    byDay.set(d.toISOString().slice(0, 10), 0);
  }
  for (const v of completedVisits) {
    if (!v.completedAt) continue;
    const key = v.completedAt.toISOString().slice(0, 10);
    if (byDay.has(key)) byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  const visitsByDay = Array.from(byDay, ([date, count]) => ({ date, count }));

  const topServices = serviceGroups
    .map((g) => ({ name: g.serviceName?.trim() || "Unspecified", count: g._count._all }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Collapse redemptions by reward name (note). The query already excludes earn
  // rows (punchesRedeemed = 0) and correction rows (reversalOfId not null), so
  // only real redemptions reach here.
  const rewardCounts = new Map<string, number>();
  for (const r of redemptionRows) {
    const name = r.note?.trim() || "Reward";
    rewardCounts.set(name, (rewardCounts.get(name) ?? 0) + 1);
  }
  const topRewards = Array.from(rewardCounts, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const nudgeByStatus = new Map(nudgeGroups.map((g) => [g.status, g._count._all]));

  res.json({
    days,
    since: since.toISOString(),
    completedVisits: completedVisits.length,
    visitsByDay,
    topServices,
    topRewards,
    rewardRedemptions: redemptionRows.length,
    promoRedemptions: promoUses,
    sms: {
      sent: nudgeByStatus.get("SENT") ?? 0,
      failed: nudgeByStatus.get("FAILED") ?? 0,
      skipped: nudgeByStatus.get("SKIPPED") ?? 0,
      pending: nudgeByStatus.get("PENDING") ?? 0,
      ledToBooking: nudgeBookings,
    },
  });
});

// Comp a shop to free full access (or revoke it). The one operator write that
// isn't better done in the Stripe dashboard - it's independent of Stripe.
const compSchema = z.object({ compAccess: z.boolean() }).strict();

adminPortalRouter.post("/shops/:shopId/comp", async (req, res) => {
  const parsed = compSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  try {
    const shop = await prisma.shop.update({
      where: { id: req.params.shopId },
      data: { compAccess: parsed.data.compAccess },
      select: { id: true, compAccess: true },
    });
    res.json({ ok: true, ...shop });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});
