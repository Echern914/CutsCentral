import { Router } from "express";
import { z } from "zod";
import { ACTIVE_SHOP_COOKIE_NAME, APP_NAME, apiEnv } from "@chairback/config";
import { Prisma, prisma, runAsOwner } from "@chairback/db";
import { requireUser, resolveOwnedShop } from "../middleware/auth.js";
import { accountLimiter } from "../middleware/rateLimit.js";
import { emailEnabled, sendEmail } from "../messaging/email.js";
import { logger } from "../logger.js";
import {
  NOTHING_SHARED,
  linksForMember,
  sharingOf,
  teamNumbers,
} from "../services/teamLinks.js";
import { rateHistory, rentPayments, rentSummary, stopRentOnLeave } from "../services/boothRent.js";

/**
 * TEAMS, from the member's side: a barber linking THEIR OWN business to a
 * shop's team, choosing what that shop sees, and leaving.
 *
 * Every route acts on businesses the signed-in person OWNS (Shop.ownerId),
 * whichever shop the switcher currently has open - a link is the business's
 * decision, so only its owner makes it.
 *
 * 🔴 NO BILLING GATE, deliberately. A barber must always be able to hide their
 * numbers or leave a team, trial or no trial.
 */
export const teamsRouter: Router = Router();
teamsRouter.use(requireUser);

const env = apiEnv();

/** GET /api/teams - the teams this person's business is on or waiting for. */
teamsRouter.get("/", async (req, res) => {
  const business = await resolveOwnedShop(
    req.userId!,
    req.cookies?.[ACTIVE_SHOP_COOKIE_NAME] as string | undefined,
  );
  if (!business) {
    res.json({ business: null, links: [] });
    return;
  }
  const links = await linksForMember(business.id);
  const now = new Date();
  res.json({
    business: { id: business.id, name: business.name },
    links: await Promise.all(
      links.map(async (l) => ({
        id: l.id,
        status: l.status,
        requestedAt: l.requestedAt.toISOString(),
        approvedAt: l.approvedAt?.toISOString() ?? null,
        team: { name: l.teamShop.name },
        sharing: sharingOf(l),
        // Exactly what the team's owner sees right now - the same function
        // their page calls - so this preview can't drift from the truth.
        theySee:
          l.status === "ACTIVE"
            ? await teamNumbers(
                { id: business.id, timezone: business.timezone },
                sharingOf(l),
                now,
              )
            : null,
        // Their own booth rent with this team - the same summary the owner sees.
        rent:
          l.status === "ACTIVE"
            ? await runAsOwner((tx) => rentSummary(tx, l.id, l.teamShop.timezone, now))
            : null,
      })),
    ),
  });
});

/** GET /api/teams/:id/rent - this business's rent to a team: the owner's own view. Read-only. */
teamsRouter.get("/:id/rent", async (req, res) => {
  const history = await runAsOwner(async (tx) => {
    const link = await tx.teamLink.findFirst({
      where: { id: req.params.id, memberShop: { ownerId: req.userId } },
      select: { id: true, teamShop: { select: { timezone: true } } },
    });
    if (!link) return null;
    return {
      summary: await rentSummary(tx, link.id, link.teamShop.timezone),
      payments: await rentPayments(tx, link.id),
      rates: await rateHistory(tx, link.id),
    };
  });
  if (!history) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(history);
});

const teamKey = z.string().trim().min(1).max(120);

/**
 * Find a team by what its link carries: the shop's id. Never its web address -
 * that can change and be taken by another shop, and an old link would then
 * send the request (and later the shared numbers) to the wrong owner.
 */
function findTeam(key: string) {
  return prisma.shop.findUnique({
    where: { id: key },
    select: { id: true, name: true, ownerId: true },
  });
}

/**
 * GET /api/teams/preview?team= - everything the team link page needs in one
 * read: the team's name (already public on its page), whether it's the
 * person's own team, their business, and whether they've already asked.
 */
teamsRouter.get("/preview", async (req, res) => {
  const key = teamKey.safeParse(req.query.team);
  if (!key.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const team = await findTeam(key.data);
  if (!team) {
    res.status(404).json({ error: "team_not_found" });
    return;
  }
  const business = await resolveOwnedShop(
    req.userId!,
    req.cookies?.[ACTIVE_SHOP_COOKIE_NAME] as string | undefined,
  );
  const link =
    business && business.id !== team.id
      ? await runAsOwner((tx) =>
          tx.teamLink.findUnique({
            where: { teamShopId_memberShopId: { teamShopId: team.id, memberShopId: business.id } },
            select: { status: true },
          }),
        )
      : null;
  res.json({
    team: { name: team.name },
    ownTeam: team.ownerId === req.userId,
    business: business ? { name: business.name } : null,
    status: link && link.status !== "ENDED" ? link.status : null,
  });
});

const joinSchema = z.object({ team: teamKey }).strict();

/** A request made again (after leaving or a decline) emails the owner at most this often. */
const REASK_EMAIL_GAP_MS = 24 * 60 * 60 * 1000;

/**
 * POST /api/teams/join { team } - ask to join a shop's team.
 *
 * `team` is what the owner's link carries: their shop's id. Asking grants
 * nothing: the link starts PENDING, shares nothing, and the team's owner
 * approves it.
 */
teamsRouter.post("/join", accountLimiter, async (req, res) => {
  const parsed = joinSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const business = await resolveOwnedShop(
    req.userId!,
    req.cookies?.[ACTIVE_SHOP_COOKIE_NAME] as string | undefined,
  );
  if (!business) {
    res.status(409).json({ error: "no_business" });
    return;
  }
  const team = await findTeam(parsed.data.team);
  if (!team) {
    res.status(404).json({ error: "team_not_found" });
    return;
  }
  if (team.ownerId === req.userId) {
    res.status(409).json({ error: "own_team" });
    return;
  }

  let result: { id: string; tellOwner: boolean } | { already: string };
  try {
    result = await runAsOwner(async (tx) => {
      const existing = await tx.teamLink.findUnique({
        where: { teamShopId_memberShopId: { teamShopId: team.id, memberShopId: business.id } },
        select: { id: true, status: true, requestedAt: true },
      });
      if (existing && existing.status !== "ENDED") return { already: existing.status };
      if (existing) {
        // Asking again after leaving: the same row, starting over - pending,
        // and sharing nothing until they choose again.
        const { count } = await tx.teamLink.updateMany({
          where: { id: existing.id, status: "ENDED" },
          data: {
            status: "PENDING",
            requestedAt: new Date(),
            approvedAt: null,
            endedAt: null,
            ...NOTHING_SHARED,
          },
        });
        // The request shows on the owner's Team page either way; the EMAIL
        // goes at most once a day per business, so asking, leaving and asking
        // again can't be used to keep mailing an owner.
        const tellOwner = existing.requestedAt.getTime() < Date.now() - REASK_EMAIL_GAP_MS;
        return count === 1 ? { id: existing.id, tellOwner } : { already: "PENDING" };
      }
      const created = await tx.teamLink.create({
        data: { teamShopId: team.id, memberShopId: business.id },
        select: { id: true },
      });
      return { id: created.id, tellOwner: true };
    });
  } catch (err) {
    // A double tap: both requests saw no link and one lost the unique race.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      res.status(409).json({ error: "already_linked", status: "PENDING" });
      return;
    }
    throw err;
  }
  if ("already" in result) {
    res.status(409).json({ error: "already_linked", status: result.already });
    return;
  }

  if (result.tellOwner) await tellTeamOwner(team, business.name);
  res.status(201).json({ ok: true, id: result.id, status: "PENDING", team: { name: team.name } });
});

const sharingSchema = z
  .object({
    shareCuts: z.boolean().optional(),
    shareRevenue: z.boolean().optional(),
    shareClients: z.boolean().optional(),
    shareRating: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);

/** PATCH /api/teams/:id/sharing - what this team's owner may see. Member only. */
teamsRouter.patch("/:id/sharing", accountLimiter, async (req, res) => {
  const parsed = sharingSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const link = await runAsOwner(async (tx) => {
    // Scoped to a business THIS person owns: the team's owner, or anyone else,
    // matches nothing and gets a 404.
    const { count } = await tx.teamLink.updateMany({
      where: {
        id: req.params.id,
        memberShop: { ownerId: req.userId },
        status: { in: ["PENDING", "ACTIVE"] },
      },
      data: parsed.data,
    });
    if (count === 0) return null;
    return tx.teamLink.findUnique({
      where: { id: req.params.id },
      include: { memberShop: { select: { id: true, timezone: true } } },
    });
  });
  if (!link) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({
    ok: true,
    sharing: sharingOf(link),
    theySee: link.status === "ACTIVE" ? await teamNumbers(link.memberShop, sharingOf(link)) : null,
  });
});

/**
 * POST /api/teams/:id/leave - leave a team (or withdraw a request).
 *
 * Nothing in the business changes; the link ends and every share switch goes
 * back to off, so asking again later starts private. Booth rent stops at the
 * next period boundary; what's owed stays recorded.
 */
teamsRouter.post("/:id/leave", accountLimiter, async (req, res) => {
  const count = await runAsOwner(async (tx) => {
    const { count } = await tx.teamLink.updateMany({
      where: {
        id: req.params.id,
        memberShop: { ownerId: req.userId },
        status: { in: ["PENDING", "ACTIVE"] },
      },
      data: { status: "ENDED", endedAt: new Date(), ...NOTHING_SHARED },
    });
    if (count > 0) {
      const link = await tx.teamLink.findUniqueOrThrow({
        where: { id: req.params.id },
        select: { teamShop: { select: { timezone: true } } },
      });
      await stopRentOnLeave(tx, req.params.id!, link.teamShop.timezone, req.userId!);
    }
    return count;
  });
  if (count === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});

/** Best effort: the owner hears about a request by email; the Team page lists it either way. */
async function tellTeamOwner(team: { id: string; name: string; ownerId: string }, memberName: string) {
  if (!emailEnabled()) return;
  const owner = await prisma.user.findUnique({
    where: { id: team.ownerId },
    select: { email: true },
  });
  if (!owner) return;
  try {
    await sendEmail({
      to: owner.email,
      subject: `${memberName} wants to join your team on ${APP_NAME}`,
      text: [
        `${memberName} asked to join ${team.name}'s team on ${APP_NAME}.`,
        "",
        "They keep their own business. You'll see only what they choose to share.",
        "",
        `Approve or decline: ${env.APP_BASE_URL}/dashboard/team`,
      ].join("\n"),
    });
  } catch (err) {
    logger.warn({ err, teamShopId: team.id }, "team join request email failed");
  }
}
