import { Router } from "express";
import { z } from "zod";
import { prisma } from "@chairback/db";
import { vocabularyForShop } from "@chairback/config";
import {
  AWARD_LIMITS,
  AWARD_STAT_KEYS,
  awardMonthKey,
  awardTitle,
  isMonthKey,
  monthLabel,
} from "@chairback/config/providerAward";
import { awardStatsFor, pickStats, readStats } from "../engines/providerAwards.js";

/**
 * PROVIDER OF THE MONTH - ChairBack's side (admin portal, /api/admin-portal/
 * awards). Inherits the portal's gates: a signed-in admin, from an allowed IP.
 *
 *   GET    /?month=YYYY-MM - that month's applications and awards.
 *   POST   /               - award a shop: from an application, or directly
 *                            by its handle (the first one, Jera's, had no
 *                            application to come from). Re-posting the same
 *                            shop and month edits the award.
 *   DELETE /:id            - take an award back; its application, if any,
 *                            is back to undecided.
 */
export const awardsAdminRouter: Router = Router();

awardsAdminRouter.get("/", async (req, res) => {
  const month = isMonthKey(req.query.month) ? req.query.month : awardMonthKey(new Date());
  const [applications, awards] = await Promise.all([
    prisma.providerAwardApplication.findMany({
      where: { month },
      orderBy: { createdAt: "asc" },
      take: 200,
      include: { shop: { select: { name: true, slug: true } }, user: { select: { name: true } } },
    }),
    prisma.providerAward.findMany({
      where: { month },
      orderBy: { createdAt: "asc" },
      include: { shop: { select: { name: true, slug: true } } },
    }),
  ]);
  res.json({
    month,
    monthLabel: monthLabel(month),
    applications: applications.map((a) => ({
      id: a.id,
      shop: a.shop,
      applicantName: a.user.name,
      pitch: a.pitch,
      credentials: a.credentials,
      stats: readStats(a.stats),
      status: a.status,
      createdAt: a.createdAt.toISOString(),
    })),
    awards: awards.map((a) => ({
      id: a.id,
      shop: a.shop,
      applicationId: a.applicationId,
      title: a.title,
      winnerName: a.winnerName,
      headline: a.headline,
      description: a.description,
      stats: readStats(a.stats),
    })),
  });
});

const awardSchema = z
  .object({
    month: z.string().refine(isMonthKey).optional(),
    applicationId: z.string().min(1).optional(),
    shopSlug: z.string().trim().min(1).max(80).optional(),
    title: z.string().trim().min(1).max(AWARD_LIMITS.title).optional(),
    winnerName: z.string().trim().min(1).max(AWARD_LIMITS.winnerName).optional(),
    headline: z.string().trim().min(1).max(AWARD_LIMITS.headline),
    description: z.string().trim().min(1).max(AWARD_LIMITS.description),
    statKeys: z.array(z.enum(AWARD_STAT_KEYS)).max(AWARD_STAT_KEYS.length).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.applicationId) !== Boolean(v.shopSlug), "one of applicationId or shopSlug");

awardsAdminRouter.post("/", async (req, res) => {
  const parsed = awardSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const b = parsed.data;
  const now = new Date();
  const application = b.applicationId
    ? await prisma.providerAwardApplication.findUnique({ where: { id: b.applicationId } })
    : null;
  if (b.applicationId && !application) {
    res.status(404).json({ error: "application_not_found" });
    return;
  }
  const shop = await prisma.shop.findUnique({
    where: application ? { id: application.shopId } : { slug: b.shopSlug!.replace(/^@/, "").toLowerCase() },
    select: {
      id: true,
      name: true,
      timezone: true,
      industry: true,
      serviceNoun: true,
      businessTypeSelectedAt: true,
      owner: { select: { name: true } },
    },
  });
  if (!shop) {
    res.status(404).json({ error: "shop_not_found" });
    return;
  }
  const month = application?.month ?? b.month ?? awardMonthKey(now);
  // From an application: what they put forward. Directly: their own numbers,
  // read now. Either way, narrowed to what ChairBack chose to show.
  const stats = pickStats(
    application ? readStats(application.stats) : await awardStatsFor(shop, now),
    b.statKeys,
  );
  const ownerName = shop.owner.name?.trim();
  const data = {
    applicationId: application?.id ?? null,
    title: b.title ?? awardTitle(vocabularyForShop(shop).providerNoun),
    // An Apple sign-in can carry an email as the name: never published.
    winnerName: b.winnerName ?? (ownerName && !ownerName.includes("@") ? ownerName : shop.name),
    headline: b.headline,
    description: b.description,
    stats: stats as unknown as object,
    awardedById: req.userId ?? null,
  };
  const award = await prisma.$transaction(async (tx) => {
    const saved = await tx.providerAward.upsert({
      where: { shopId_month: { shopId: shop.id, month } },
      create: { shopId: shop.id, month, ...data },
      update: data,
    });
    if (application) {
      await tx.providerAwardApplication.update({ where: { id: application.id }, data: { status: "WON" } });
    }
    return saved;
  });
  res.status(201).json({
    ok: true,
    award: {
      id: award.id,
      shop: { name: shop.name },
      month,
      title: award.title,
      winnerName: award.winnerName,
      headline: award.headline,
      description: award.description,
      stats: readStats(award.stats),
    },
  });
});

awardsAdminRouter.delete("/:id", async (req, res) => {
  const award = await prisma.providerAward.findUnique({ where: { id: req.params.id } });
  if (!award) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await prisma.$transaction(async (tx) => {
    await tx.providerAward.delete({ where: { id: award.id } });
    if (award.applicationId) {
      await tx.providerAwardApplication.updateMany({
        where: { id: award.applicationId, status: "WON" },
        data: { status: "SUBMITTED" },
      });
    }
  });
  res.json({ ok: true });
});
