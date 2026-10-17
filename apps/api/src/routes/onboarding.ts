import { Router } from "express";
import { z } from "zod";
import { Prisma, prisma, runWithShop } from "@chairback/db";
import { onboardingFactsFor } from "../engines/onboardingFacts.js";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireOwner } from "../auth/roles.js";
import { accountLimiter } from "../middleware/rateLimit.js";
import { nameKey } from "../engines/acuityServiceImport.js";
import { linkStaffToOfferedByAllServices } from "../services/offeredByAll.js";

/**
 * FIRST-TIME SETUP (web /onboarding, config/onboarding.ts).
 *
 * What a new shop has and hasn't set up yet, read from its own data, so the
 * setup screens never ask what is already answered and a shop that leaves half
 * way comes back to the first thing still missing. The steps themselves save
 * through the routes the dashboard already uses (booking mode through PATCH
 * /api/shops/me, services through /api/booking/services/bulk, hours through
 * /api/booking/staff/:id/availability) - except adding the team's chairs,
 * which is here so a retried or doubled tap can't add anyone twice.
 *
 * The owner's alone: setting the shop up is not a seat's job.
 */
export const onboardingRouter: Router = Router();
onboardingRouter.use(requireUser, requireShop, requireOwner);

onboardingRouter.get("/state", async (req, res) => {
  const shopId = req.shop!.id;
  // Shop, User and the connections are default-deny inside a tenant
  // transaction: plain prisma, scoped by id.
  const [facts, shop, user, acuity, square, staff, services] = await Promise.all([
    // What is done - the one definition, shared with the team owner's view.
    onboardingFactsFor(shopId),
    prisma.shop.findUniqueOrThrow({
      where: { id: shopId },
      select: {
        name: true,
        slug: true,
        publicPageEnabled: true,
        timezone: true,
        industry: true,
        onboardingCompletedAt: true,
      },
    }),
    prisma.user.findUnique({ where: { id: req.userId! }, select: { name: true } }),
    prisma.acuityConnection.findUnique({ where: { shopId }, select: { id: true } }),
    prisma.squareConnection.findUnique({ where: { shopId }, select: { id: true } }),
    prisma.staff.findMany({
      where: { shopId, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true },
    }),
    prisma.service.findMany({
      where: { shopId, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { name: true },
      take: 500,
    }),
  ]);
  const withHours = new Set(
    (
      await prisma.availabilityRule.findMany({
        where: { shopId, staffId: { in: staff.map((s) => s.id) } },
        distinct: ["staffId"],
        select: { staffId: true },
      })
    ).map((r) => r.staffId),
  );
  res.json({
    facts,
    shop: {
      name: shop.name,
      slug: shop.slug,
      publicPageEnabled: shop.publicPageEnabled,
      timezone: shop.timezone,
      industry: shop.industry,
      completedAt: shop.onboardingCompletedAt?.toISOString() ?? null,
    },
    integrations: { acuity: Boolean(acuity), square: Boolean(square) },
    // An Apple sign-in can carry an email address as the name: never offered
    // as a chair's (public) name.
    me: { name: user?.name && !user.name.includes("@") ? user.name.trim() : "" },
    staff: staff.map((s) => ({ id: s.id, name: s.name, hasHours: withHours.has(s.id) })),
    // What the menu already has: setup shows them, and never adds one twice.
    services: services.map((s) => s.name),
  });
});

const teamSchema = z
  .object({ names: z.array(z.string().trim().min(1).max(60)).min(1).max(20) })
  .strict();

/**
 * POST /team - the chairs of the people who take appointments, by name. A
 * name already on an active chair is skipped (the owner who comes back, a
 * second tap, a lost answer retried), so this never makes anyone twice. Each
 * new chair is offered every "offered by all" service, like Add staff.
 *
 * The owner's own chair is an ordinary chair named after them, NOT linked to
 * their login: a linked owner's day-ahead reminder would narrow from the
 * whole shop to their own chair. An unlinked chair's alerts already reach the
 * owner.
 */
onboardingRouter.post("/team", accountLimiter, async (req, res) => {
  const parsed = teamSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const shopId = req.shop!.id;
  const result = await runWithShop(shopId, async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`onboardteam:${shopId}`}))`);
    const existing = await tx.staff.findMany({ where: { shopId, active: true }, select: { name: true } });
    const taken = new Set(existing.map((s) => nameKey(s.name)));
    const created: { id: string; name: string }[] = [];
    const skipped: string[] = [];
    for (const raw of parsed.data.names) {
      const name = raw.replace(/\s+/g, " ").trim();
      const key = nameKey(name);
      if (taken.has(key)) {
        skipped.push(name);
        continue;
      }
      taken.add(key);
      created.push(await tx.staff.create({ data: { shopId, name, active: true }, select: { id: true, name: true } }));
    }
    return { created, skipped };
  });
  // After the commit, like Add staff: a chair is real without its services.
  for (const s of result.created) await linkStaffToOfferedByAllServices(shopId, s.id);
  res.status(201).json(result);
});

/**
 * POST /complete - setup finished, or skipped ("Skip setup for now"). Signing
 * in no longer resumes it, and the first dashboard visit doesn't start the
 * tour by itself: the finish screen offers it.
 */
onboardingRouter.post("/complete", accountLimiter, async (req, res) => {
  const shopId = req.shop!.id;
  await prisma.shop.updateMany({
    where: { id: shopId, onboardingCompletedAt: null },
    data: { onboardingCompletedAt: new Date() },
  });
  await prisma.user.updateMany({
    where: { id: req.userId!, welcomeSeenAt: null },
    data: { welcomeSeenAt: new Date() },
  });
  res.json({ ok: true });
});

