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
