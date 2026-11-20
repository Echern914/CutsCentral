import { Router } from "express";
import { z } from "zod";
import { Prisma, prisma, runWithShop } from "@chairback/db";
import { onboardingFactsFor } from "../engines/onboardingFacts.js";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireOwner } from "../auth/roles.js";
import { accountLimiter } from "../middleware/rateLimit.js";
import { nameKey } from "../engines/acuityServiceImport.js";
import { linkStaffToOfferedByAllServices } from "../services/offeredByAll.js";
import { emailEnabled } from "../messaging/email.js";
import { sendTeamInvite } from "../services/teamInvite.js";

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

const personNameSchema = z.string().trim().min(1).max(60);
const teamSchema = z.union([
  // Names only: the solo path, and every client built before `people` existed.
  z.object({ names: z.array(personNameSchema).min(1).max(20) }).strict(),
  // A team: each person by name, with an email for anyone who should get a
  // login of their own. Blank email = a chair, no login (the owner invites
  // them later on Team).
  z
    .object({
      people: z
        .array(
          z
            .object({
              name: personNameSchema,
              email: z.string().trim().email().max(200).optional().or(z.literal("")),
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict()
    // One address is one login: the second invitation to an address replaces
    // the first, so two people sharing one would leave one of them with no way
    // in and no warning.
    .refine(
      (d) => {
        const emails = d.people.map((p) => (p.email ?? "").toLowerCase()).filter(Boolean);
        return new Set(emails).size === emails.length;
      },
      { message: "Each email can be used for one person." },
    ),
]);

/** What happened to the invitation for one person setup was given an email for. */
type SetupInviteOutcome =
  | "sent"
  // Email is not configured on this server: the chair exists, nothing was sent.
  | "email_unavailable"
  // The send failed. The invitation is written; the owner resends it on Team.
  | "email_failed"
  // That address already signs in to this shop (the owner's own, or a retry
  // after they accepted).
  | "already_member"
  // Their chair is already linked to someone else's login.
  | "already_linked";

/**
 * POST /team - the chairs of the people who take appointments, by name. A
 * name already on an active chair is skipped (the owner who comes back, a
 * second tap, a lost answer retried), so this never makes anyone twice. Each
 * new chair is offered every "offered by all" service, like Add staff.
 *
 * With `people`, anyone given an email is also sent the same invitation the
 * Team page sends (services/teamInvite.ts), naming THEIR chair - so when they
 * accept, they open their own day instead of a screen asking the owner to
 * link them. The chairs are made whether or not a single email goes out: a
 * shop is bookable without anyone else signing in, and each invitation's
 * outcome comes back so setup can say which ones to resend from Team. A
 * retry is safe: the name is skipped, the invitation is sent again for the
 * chair that name already has, and the earlier link stops working.
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
  const clean = (raw: string) => raw.replace(/\s+/g, " ").trim();
  const people: { name: string; email: string | null }[] =
    "people" in parsed.data
      ? parsed.data.people.map((p) => ({ name: clean(p.name), email: p.email ? p.email.toLowerCase() : null }))
      : parsed.data.names.map((n) => ({ name: clean(n), email: null }));

  const result = await runWithShop(shopId, async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`onboardteam:${shopId}`}))`);
    const existing = await tx.staff.findMany({ where: { shopId, active: true }, select: { id: true, name: true } });
    // Name -> the chair that has it, old or just made: what an invitation names.
    const chairByName = new Map(existing.map((s) => [nameKey(s.name), s.id]));
    const created: { id: string; name: string }[] = [];
    const skipped: string[] = [];
    for (const { name } of people) {
      const key = nameKey(name);
      if (chairByName.has(key)) {
        skipped.push(name);
        continue;
      }
      const chair = await tx.staff.create({ data: { shopId, name, active: true }, select: { id: true, name: true } });
      chairByName.set(key, chair.id);
      created.push(chair);
    }
    return { created, skipped, chairByName };
  });
  // After the commit, like Add staff: a chair is real without its services.
  for (const s of result.created) await linkStaffToOfferedByAllServices(shopId, s.id);

  // The invitations, last: by now every chair is committed and offered, so
  // nothing below can cost the shop a chair.
  const invites: { name: string; email: string; outcome: SetupInviteOutcome }[] = [];
  const wanted = people.filter((p): p is { name: string; email: string } => p.email !== null);
  if (wanted.length > 0) {
    const canSend = emailEnabled();
    // Plain prisma for both: the joined User is default-deny inside a tenant
    // transaction, and ShopMember.staffId is unique across shops anyway.
    const [members, owner] = canSend
      ? await Promise.all([
          prisma.shopMember.findMany({
            where: { shopId },
            select: { staffId: true, user: { select: { email: true } } },
          }),
          prisma.user.findUnique({ where: { id: req.userId! }, select: { email: true } }),
        ])
      : [[], null];
    const onTeam = new Set(members.map((m) => m.user.email.toLowerCase()));
    if (owner) onTeam.add(owner.email.toLowerCase());
    const claimedChairs = new Set(members.map((m) => m.staffId).filter((id): id is string => id !== null));
    for (const p of wanted) {
      const chairId = result.chairByName.get(nameKey(p.name)) ?? null;
      let outcome: SetupInviteOutcome;
      if (!canSend) outcome = "email_unavailable";
      else if (onTeam.has(p.email)) outcome = "already_member";
      else if (!chairId || claimedChairs.has(chairId)) outcome = "already_linked";
      else {
        outcome = await sendTeamInvite({
          shopId,
          shopName: req.shop!.name,
          email: p.email,
          role: "BARBER",
          staffId: chairId,
          invitedById: req.userId!,
        });
      }
      invites.push({ name: p.name, email: p.email, outcome });
    }
  }
  res.status(201).json({ created: result.created, skipped: result.skipped, invites });
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

