import { Router } from "express";
import { z } from "zod";
import { prisma } from "@chairback/db";
import { AWARD_LIMITS, AWARD_STAT_KEYS, awardMonthKey, monthLabel } from "@chairback/config/providerAward";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireOwner } from "../auth/roles.js";
import { accountLimiter } from "../middleware/rateLimit.js";
import { awardStatsFor, pickStats, publicAwardFor, readStats, toPublicAward } from "../engines/providerAwards.js";

/**
 * PROVIDER OF THE MONTH (config/providerAward.ts).
 *
 *   GET  /api/awards/public/:slug - the award a shop's public page shows now.
 *   GET  /api/awards/me           - this month, this shop's stats, its
 *                                   application and the awards it has won.
 *   POST /api/awards/apply        - apply (or change the application) for
 *                                   this month, with the stats it chooses.
 *
 * Applying is the shop OWNER's: it puts the shop's numbers forward. ChairBack
 * picks winners in the admin portal (routes/awardsAdmin.ts). The award tables
 * are default-deny, so every read here is plain prisma scoped by shop id.
 */
export const awardsRouter: Router = Router();

awardsRouter.get("/public/:slug", async (req, res) => {
  const shop = await prisma.shop.findUnique({
    where: { slug: String(req.params.slug).toLowerCase() },
    select: { id: true, publicPageEnabled: true },
  });
  // A page that isn't public says nothing - not even that it won.
  if (!shop || !shop.publicPageEnabled) {
    res.json({ award: null });
    return;
  }
  res.set("Cache-Control", "public, max-age=60");
  res.json({ award: await publicAwardFor(shop.id) });
});

awardsRouter.use(requireUser, requireShop, requireOwner);

awardsRouter.get("/me", async (req, res) => {
  const shopId = req.shop!.id;
  const now = new Date();
  const month = awardMonthKey(now);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId }, select: { id: true, timezone: true } });
  const [stats, application, won, pending] = await Promise.all([
    awardStatsFor(shop, now),
    prisma.providerAwardApplication.findUnique({ where: { shopId_month: { shopId, month } } }),
    prisma.providerAward.findMany({ where: { shopId, status: "APPROVED" }, orderBy: { month: "desc" }, take: 12 }),
    prisma.providerAward.findFirst({ where: { shopId, status: "PENDING" }, orderBy: { month: "desc" } }),
  ]);
  res.json({
    month,
    monthLabel: monthLabel(month),
    stats,
    application: application
      ? {
          pitch: application.pitch,
          credentials: application.credentials,
          stats: readStats(application.stats),
          status: application.status,
          updatedAt: application.updatedAt.toISOString(),
        }
      : null,
    // Chosen, waiting for their OK: exactly what the card will show.
    pending: pending ? { id: pending.id, ...toPublicAward(pending) } : null,
    won: won.map((a) => ({
      month: a.month,
      monthLabel: monthLabel(a.month),
      title: a.title,
      headline: a.headline,
      description: a.description,
    })),
  });
});

const applySchema = z
  .object({
    pitch: z.string().trim().min(1).max(AWARD_LIMITS.pitch),
    credentials: z.string().trim().max(AWARD_LIMITS.credentials).optional(),
    statKeys: z.array(z.enum(AWARD_STAT_KEYS)).max(AWARD_STAT_KEYS.length),
  })
  .strict();

awardsRouter.post("/apply", accountLimiter, async (req, res) => {
  const parsed = applySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const shopId = req.shop!.id;
  const now = new Date();
  const month = awardMonthKey(now);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId }, select: { id: true, timezone: true } });
  // The numbers are read HERE, from the shop's own data - never taken from
  // the request, so nobody can apply with a number they made up.
  const stats = pickStats(await awardStatsFor(shop, now), parsed.data.statKeys);
  const existing = await prisma.providerAwardApplication.findUnique({
    where: { shopId_month: { shopId, month } },
    select: { status: true },
  });
  // Decided is decided: a winner's application, or one not chosen, stays as
  // it was judged.
  if (existing && existing.status !== "SUBMITTED") {
    res.status(409).json({ error: "already_decided" });
    return;
  }
  const data = {
    pitch: parsed.data.pitch,
    credentials: parsed.data.credentials || null,
    stats: stats as unknown as object,
    userId: req.userId!,
  };
  const saved = await prisma.providerAwardApplication.upsert({
    where: { shopId_month: { shopId, month } },
    create: { shopId, month, ...data },
    update: data,
  });
  res.status(existing ? 200 : 201).json({
    ok: true,
    month,
    application: {
      pitch: saved.pitch,
      credentials: saved.credentials,
      stats: readStats(saved.stats),
      status: saved.status,
      updatedAt: saved.updatedAt.toISOString(),
    },
  });
});

/** GET /api/awards/pending - is an award waiting for this shop's OK? (the bell) */
awardsRouter.get("/pending", async (req, res) => {
  const pending = await prisma.providerAward.findFirst({
    where: { shopId: req.shop!.id, status: "PENDING" },
    orderBy: { month: "desc" },
    select: { title: true, month: true },
  });
  res.json({ pending: pending ? { title: pending.title, monthLabel: monthLabel(pending.month) } : null });
});

/**
 * POST /api/awards/:id/approve | /decline - the winner says yes, or no, to
 * exactly what ChairBack wrote. Nothing is on their page until they approve
 * (Eric, 2026-10-17). Only this shop's own award, and only while it waits:
 * a second tap, or one after an edit was re-sent, changes nothing twice.
 */
for (const decision of ["approve", "decline"] as const) {
  awardsRouter.post(`/:id/${decision}`, accountLimiter, async (req, res) => {
    const status = decision === "approve" ? "APPROVED" : "DECLINED";
    const award = await prisma.providerAward.findFirst({
      where: { id: req.params.id, shopId: req.shop!.id },
      select: { id: true, status: true, applicationId: true, shop: { select: { slug: true } } },
    });
    if (!award) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const done = await prisma.$transaction(async (tx) => {
      // The status check IS the write: a double tap or a stale screen finds
      // nothing left to change.
      const { count } = await tx.providerAward.updateMany({
        where: { id: award.id, status: "PENDING" },
        data: { status, decidedAt: new Date() },
      });
      if (count === 1 && award.applicationId) {
        await tx.providerAwardApplication.update({
          where: { id: award.applicationId },
          data: { status: decision === "approve" ? "WON" : "SUBMITTED" },
        });
      }
      return count === 1;
    });
    if (!done) {
      res.status(409).json({ error: "already_decided" });
      return;
    }
    // The slug, so the web can refresh that page now rather than in a minute.
    res.json({ ok: true, status, slug: award.shop.slug });
  });
}
