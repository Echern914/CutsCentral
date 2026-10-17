import { Router } from "express";
import { z } from "zod";
import { ACTIVE_SHOP_COOKIE_NAME, APP_NAME, apiEnv } from "@chairback/config";
import { Prisma, prisma, runAsOwner } from "@chairback/db";
import { requireUser, resolveOwnedShop } from "../middleware/auth.js";
import { accountLimiter } from "../middleware/rateLimit.js";
import { endMentorshipsForLink, mentorshipsForMemberLink } from "../services/teamMentorships.js";
import { emailEnabled, sendEmail } from "../messaging/email.js";
import { logger } from "../logger.js";
import {
  LINK_NOTHING_SHARED,
  NOTHING_SHARED,
  linksForMember,
  recordSharingChanges,
  recordTeamEvent,
  sharingOf,
  teamNumbers,
} from "../services/teamLinks.js";
import { memberToday } from "../services/teamSchedule.js";
import {
  HAS_RENT_RECORDS,
  rateHistory,
  rentPayments,
  rentSummary,
  stopRentOnLeave,
} from "../services/boothRent.js";

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
    res.json({ business: null, links: [], past: [] });
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
        // The team's zone: their schedule preview reads times as the owner does.
        team: { name: l.teamShop.name, timezone: l.teamShop.timezone },
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
        // Their schedule: whether the owner sees it, and - when they do -
        // today exactly as the owner's Team page shows it (same function).
        shareSchedule: l.shareSchedule,
        // Whether the owner sees how far their setup is (yes/no per step).
        shareSetup: l.shareSetup,
        scheduleToday:
          l.status === "ACTIVE" && l.shareSchedule
            ? await memberToday({ id: business.id, timezone: business.timezone }, l.teamShop.timezone, now)
            : null,
        // The front desk: whether they take its walk-ins, and whether their
        // own line is on to receive them. Nothing while Walk-In Mode is off.
        walkIns: apiEnv().WALK_IN_MODE_ENABLED
          ? { take: l.takeTeamWalkIns, lineOn: business.walkInEnabled }
          : null,
        // Their own booth rent with this team - the same summary the owner
        // sees. Also while asking to rejoin: an old record never disappears.
        rent: await runAsOwner((tx) => rentSummary(tx, l.id, l.teamShop.timezone, now)),
        // Mentorship on this team: the mentors they have (and what each one
        // sees) and the members they mentor (only what each shares).
        ...(l.status === "ACTIVE"
          ? await mentorshipsForMemberLink(l.id, now)
          : { mentors: [], mentoring: [] }),
      })),
    ),
    // Teams they've left, where booth rent was recorded: read-only, the rent
    // and the team's name - nothing of the team, nothing of their numbers.
    past: await runAsOwner(async (tx) => {
      const ended = await tx.teamLink.findMany({
        where: { memberShopId: business.id, status: "ENDED", ...HAS_RENT_RECORDS },
        orderBy: { updatedAt: "desc" },
        select: { id: true, endedAt: true, teamShop: { select: { name: true, timezone: true } } },
      });
      return Promise.all(
        ended.map(async (l) => ({
          id: l.id,
          endedAt: l.endedAt?.toISOString() ?? null,
          team: { name: l.teamShop.name },
          rent: await rentSummary(tx, l.id, l.teamShop.timezone, now),
        })),
      );
    }),
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
            ...LINK_NOTHING_SHARED,
            // Setup progress starts shown, as on a first request.
            shareSetup: true,
          },
        });
        // The request shows on the owner's Team page either way; the EMAIL
        // goes at most once a day per business, so asking, leaving and asking
        // again can't be used to keep mailing an owner.
        const tellOwner = existing.requestedAt.getTime() < Date.now() - REASK_EMAIL_GAP_MS;
        if (count !== 1) return { already: "PENDING" };
        await recordTeamEvent(tx, { id: existing.id, teamShopId: team.id }, "requested");
        return { id: existing.id, tellOwner };
      }
      const created = await tx.teamLink.create({
        data: { teamShopId: team.id, memberShopId: business.id },
        select: { id: true },
      });
      await recordTeamEvent(tx, { id: created.id, teamShopId: team.id }, "requested");
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

const numberShares = {
  shareCuts: z.boolean().optional(),
  shareRevenue: z.boolean().optional(),
  shareClients: z.boolean().optional(),
  shareRating: z.boolean().optional(),
};
/** What a MENTOR may see: numbers only. */
const sharingSchema = z
  .object(numberShares)
  .strict()
  .refine((v) => Object.keys(v).length > 0);
/** What the team's OWNER may see: the numbers, and the member's schedule. */
const linkSharingSchema = z
  .object({ ...numberShares, shareSchedule: z.boolean().optional(), shareSetup: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0);

/** PATCH /api/teams/:id/sharing - what this team's owner may see. Member only. */
teamsRouter.patch("/:id/sharing", accountLimiter, async (req, res) => {
  const parsed = linkSharingSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const link = await runAsOwner(async (tx) => {
    // Scoped to a business THIS person owns: the team's owner, or anyone else,
    // matches nothing and gets a 404.
    const mine = {
      id: req.params.id,
      memberShop: { ownerId: req.userId },
      status: { in: ["PENDING" as const, "ACTIVE" as const] },
    };
    const before = await tx.teamLink.findFirst({ where: mine });
    if (!before) return null;
    const { count } = await tx.teamLink.updateMany({ where: mine, data: parsed.data });
    if (count === 0) return null;
    const after = await tx.teamLink.findUniqueOrThrow({
      where: { id: req.params.id },
      include: {
        memberShop: { select: { id: true, timezone: true } },
        teamShop: { select: { timezone: true } },
      },
    });
    // The owner's feed: which number was shared or hidden - never its value.
    await recordSharingChanges(tx, after, sharingOf(before), sharingOf(after));
    if (before.shareSchedule !== after.shareSchedule) {
      await recordTeamEvent(tx, after, after.shareSchedule ? "shared" : "hid", "schedule");
    }
    if (before.shareSetup !== after.shareSetup) {
      await recordTeamEvent(tx, after, after.shareSetup ? "shared" : "hid", "setup");
    }
    return after;
  });
  if (!link) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const active = link.status === "ACTIVE";
  res.json({
    ok: true,
    sharing: sharingOf(link),
    theySee: active ? await teamNumbers(link.memberShop, sharingOf(link)) : null,
    shareSchedule: link.shareSchedule,
    shareSetup: link.shareSetup,
    scheduleToday:
      active && link.shareSchedule ? await memberToday(link.memberShop, link.teamShop.timezone) : null,
  });
});

const walkInsSchema = z.object({ take: z.boolean() }).strict();

/**
 * PATCH /api/teams/:id/walk-ins { take } - take walk-ins who check in at this
 * team's front desk. They join THIS business's own line, on its own books.
 * Member only; 404 while Walk-In Mode is off for the platform.
 */
teamsRouter.patch("/:id/walk-ins", accountLimiter, async (req, res) => {
  if (!apiEnv().WALK_IN_MODE_ENABLED) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const parsed = walkInsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const link = await runAsOwner(async (tx) => {
    const mine = {
      id: req.params.id,
      memberShop: { ownerId: req.userId },
      status: { in: ["PENDING" as const, "ACTIVE" as const] },
    };
    const before = await tx.teamLink.findFirst({ where: mine, select: { takeTeamWalkIns: true } });
    if (!before) return null;
    const { count } = await tx.teamLink.updateMany({ where: mine, data: { takeTeamWalkIns: parsed.data.take } });
    if (count === 0) return null;
    const after = await tx.teamLink.findUniqueOrThrow({
      where: { id: req.params.id },
      select: { id: true, teamShopId: true, takeTeamWalkIns: true, memberShop: { select: { walkInEnabled: true } } },
    });
    if (before.takeTeamWalkIns !== after.takeTeamWalkIns) {
      await recordTeamEvent(tx, after, after.takeTeamWalkIns ? "walk_ins_on" : "walk_ins_off");
    }
    return after;
  });
  if (!link) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true, walkIns: { take: link.takeTeamWalkIns, lineOn: link.memberShop.walkInEnabled } });
});

/**
 * PATCH /api/teams/mentorships/:id/sharing - what THIS mentor may see. Only the
 * student changes it, and only while the pairing is live. Answers with the
 * numbers the mentor now reads, so the preview shows the truth.
 */
teamsRouter.patch("/mentorships/:id/sharing", accountLimiter, async (req, res) => {
  const parsed = sharingSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const row = await runAsOwner(async (tx) => {
    const { count } = await tx.teamMentorship.updateMany({
      where: {
        id: req.params.id,
        status: "ACTIVE",
        studentLink: { status: "ACTIVE", memberShop: { ownerId: req.userId } },
      },
      data: parsed.data,
    });
    if (count === 0) return null;
    return tx.teamMentorship.findUniqueOrThrow({
      where: { id: req.params.id },
      include: { studentLink: { select: { memberShop: { select: { id: true, timezone: true } } } } },
    });
  });
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({
    ok: true,
    sharing: sharingOf(row),
    theySee: await teamNumbers(row.studentLink.memberShop, sharingOf(row)),
  });
});

/** POST /api/teams/mentorships/:id/end - the student OR the mentor ends a pairing. */
teamsRouter.post("/mentorships/:id/end", accountLimiter, async (req, res) => {
  const { count } = await runAsOwner((tx) =>
    tx.teamMentorship.updateMany({
      where: {
        id: req.params.id,
        status: "ACTIVE",
        OR: [
          { studentLink: { memberShop: { ownerId: req.userId } } },
          { mentorLink: { memberShop: { ownerId: req.userId } } },
        ],
      },
      data: { status: "ENDED", endedAt: new Date(), ...NOTHING_SHARED },
    }),
  );
  if (count === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
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
    // Read first: leaving an ACTIVE team and withdrawing a PENDING request are
    // different lines in the owner's feed.
    const was = await tx.teamLink.findFirst({
      where: {
        id: req.params.id,
        memberShop: { ownerId: req.userId },
        status: { in: ["PENDING", "ACTIVE"] },
      },
      select: { id: true, status: true, teamShopId: true },
    });
    if (!was) return 0;
    const { count } = await tx.teamLink.updateMany({
      where: { id: was.id, status: was.status },
      data: { status: "ENDED", endedAt: new Date(), ...LINK_NOTHING_SHARED },
    });
    if (count > 0) {
      await recordTeamEvent(tx, was, was.status === "ACTIVE" ? "left" : "withdrew");
      // Off the team: every mentor pairing they were in ends with it.
      await endMentorshipsForLink(tx, was.id);
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
