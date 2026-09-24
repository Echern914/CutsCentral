import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { APP_NAME, apiEnv, randomToken, vocabularyForShop } from "@chairback/config";
import { forShop, prisma, runAsOwner, type Prisma } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireManager, requireOwner } from "../auth/roles.js";
import { accountLimiter, dashboardLimiter } from "../middleware/rateLimit.js";
import { emailEnabled, sendEmail } from "../messaging/email.js";
import { applyChairLink, releaseChairLink } from "../services/staffUserLink.js";
import { linkStaffToOfferedByAllServices } from "../services/offeredByAll.js";
import { NOTHING_SHARED, linksForTeam, sharingOf, teamNumbers } from "../services/teamLinks.js";
import { PAYMENT_METHODS, rentPayments, rentSummary } from "../services/boothRent.js";
import { shopLocalDay } from "../engines/insightsWindow.js";
import { logger } from "../logger.js";

import { requireActiveAccess } from "../middleware/billing.js";
/**
 * TEAM: the shop's people, and the invitations that let them sign in.
 *
 * Before this, a barbershop owner could add a `Staff` row — a name, a photo and
 * weekly hours on the booking calendar — but there was no way for that person
 * to log in. This router adds the seat (`ShopMember`) and the one-shot,
 * hashed, expiring invitation that creates one.
 *
 * OWNER-ONLY, all of it. Handing out seats is the most privileged thing in the
 * product: whoever can invite can grant access to every client record in the
 * shop. Managers run the shop; only the owner changes who can get in.
 *
 * Invite threat model mirrors passwordReset.ts exactly:
 *  - only the sha256 of the emailed token is stored, so a DB leak grants nobody
 *    a seat,
 *  - single-use (acceptedAt claimed atomically, so two racing redeems can't
 *    both win) and short-lived,
 *  - acceptance requires the signed-in user's email to MATCH the invited
 *    address, so a forwarded link can't hand a stranger a seat, and
 *  - the invite flow is dark until email is configured — no tokens are minted
 *    that could never be delivered.
 */

const env = apiEnv();
export const teamRouter: Router = Router();
// Manager-gated at the ROUTER, so a route added later inherits the restriction.
// The roster read below was previously reachable by ANY member: writes were
// requireOwner, but nothing gated the GET, so an invited BARBER could list every
// colleague's name, email and avatar plus every pending invite's email address.
// Nothing surfaced it because barbers 403'd on every other dashboard route, so
// nobody had a session that could reach this one. A barber has no business
// reading the roster; accepting an invite is a different router (teamJoin.ts)
// and is unaffected.
teamRouter.use(requireUser, requireShop, requireManager, requireActiveAccess);

/** A week: long enough for a barber to get to it, short enough to bound a stale mailbox. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * GET /api/team — everyone who can sign in, plus outstanding invitations.
 *
 * Managers can see the roster (they work with these people); only the owner can
 * change it, which the mutating routes below enforce individually.
 */
teamRouter.get("/", dashboardLimiter, async (req, res) => {
  const shopId = req.shop!.id;
  const [members, invites, staff] = await Promise.all([
    // Plain prisma: ShopMember carries a tenant policy, but the joined User is
    // a NON-tenant table that returns NULL inside runWithShop (the documented
    // Shop/User RLS default-deny gotcha). The explicit shopId keeps it scoped.
    prisma.shopMember.findMany({
      where: { shopId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        role: true,
        staffId: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
    }),
    prisma.teamInvite.findMany({
      where: { shopId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, role: true, staffId: true, expiresAt: true },
    }),
    forShop(shopId).staff.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true },
    }),
  ]);

  res.json({
    // The caller's own role, so the UI can hide owner-only controls rather
    // than offering buttons that will 403.
    role: req.shopRole,
    ownerUserId: req.shop!.ownerId,
    members: members.map((m) => ({
      id: m.id,
      role: m.role,
      staffId: m.staffId,
      joinedAt: m.createdAt.toISOString(),
      user: m.user,
    })),
    invites: invites.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      staffId: i.staffId,
      expiresAt: i.expiresAt.toISOString(),
    })),
    // Chairs available to link a seat to (an unlinked, active staff row).
    staff,
    // Invitations can't be sent at all without transactional email.
    inviteAvailable: emailEnabled(),
  });
});

const inviteSchema = z
  .object({
    email: z.string().trim().email().max(200),
    // OWNER is deliberately not invitable: there is exactly one owner, and
    // transferring a shop is a different (unbuilt) operation.
    role: z.enum(["MANAGER", "BARBER"]),
    staffId: z.string().min(1).optional(),
  })
  .strict();

/** POST /api/team/invites — email someone a link that grants them a seat. */
teamRouter.post("/invites", accountLimiter, requireOwner, async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  if (!emailEnabled()) {
    res.status(503).json({ error: "email_unavailable" });
    return;
  }
  const shopId = req.shop!.id;
  const email = parsed.data.email.toLowerCase();

  // Already on the team? Answer plainly — this is the owner's own roster, so
  // there's no enumeration concern, and "invite sent" for someone who already
  // has access would be a lie.
  const existing = await prisma.shopMember.findFirst({
    where: { shopId, user: { email } },
    select: { id: true },
  });
  if (existing) {
    res.status(409).json({ error: "already_member" });
    return;
  }

  // Linking a seat to a chair: the chair must belong to THIS shop, and can't
  // already be claimed (ShopMember.staffId is unique, but failing here gives a
  // real error instead of a constraint violation at accept time).
  const staffId = parsed.data.staffId;
  if (staffId) {
    const chair = await forShop(shopId).staff.findFirst({
      where: { id: staffId, active: true },
      select: { id: true },
    });
    if (!chair) {
      res.status(400).json({ error: "invalid_staff" });
      return;
    }
    const claimed = await prisma.shopMember.findFirst({
      where: { staffId },
      select: { id: true },
    });
    if (claimed) {
      res.status(409).json({ error: "staff_taken" });
      return;
    }
  }

  const token = randomToken(); // 32 random bytes, base64url — unguessable
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  // One live invite per address per shop: re-inviting supersedes the previous
  // link so an older email can't linger as a second way in. Accepted/revoked
  // rows are kept as an audit trail.
  await prisma.$transaction([
    prisma.teamInvite.deleteMany({
      where: { shopId, email, acceptedAt: null, revokedAt: null },
    }),
    prisma.teamInvite.create({
      data: {
        shopId,
        email,
        role: parsed.data.role,
        staffId: staffId ?? null,
        tokenHash: sha256Hex(token),
        invitedById: req.userId!,
        expiresAt,
      },
    }),
  ]);

  const acceptUrl = `${env.APP_BASE_URL}/team/join?token=${encodeURIComponent(token)}`;
  try {
    await sendEmail({
      to: email,
      subject: `${req.shop!.name} invited you to ${APP_NAME}`,
      text: [
        `${req.shop!.name} added you to their team on ${APP_NAME}.`,
        "",
        "Open this link to accept:",
        acceptUrl,
        "",
        `The link expires in 7 days and works once. Sign in with ${email} —`,
        "it only works for that address.",
        "",
        "If you weren't expecting this, you can ignore this email.",
      ].join("\n"),
    });
  } catch (err) {
    // The invite row is already written; surface the send failure so the owner
    // can retry rather than believing an email went out.
    logger.error({ err, shopId }, "team invite email failed");
    res.status(502).json({ error: "email_failed" });
    return;
  }
  res.status(201).json({ ok: true });
});

/** DELETE /api/team/invites/:id — revoke a pending invitation. */
teamRouter.delete("/invites/:id", requireOwner, async (req, res) => {
  const { count } = await prisma.teamInvite.updateMany({
    // shopId scopes it: an owner can't revoke another shop's invite by id.
    where: { id: req.params.id, shopId: req.shop!.id, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});

const memberPatchSchema = z
  .object({
    role: z.enum(["MANAGER", "BARBER"]).optional(),
    // null clears the chair link.
    staffId: z.string().min(1).nullable().optional(),
  })
  .strict();

/** PATCH /api/team/members/:id — change a seat's role or linked chair. */
teamRouter.patch("/members/:id", requireOwner, async (req, res) => {
  const parsed = memberPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const shopId = req.shop!.id;
  const member = await prisma.shopMember.findFirst({
    where: { id: req.params.id, shopId },
    // staffId: the chair they hold NOW, needed to release it when the link moves.
    select: { id: true, userId: true, role: true, staffId: true },
  });
  if (!member) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // The owner's own seat is not editable: demoting it would strand the shop
  // with no owner, and it wouldn't take effect anyway (ownership is read from
  // Shop.ownerId, not from this row).
  if (member.userId === req.shop!.ownerId) {
    res.status(409).json({ error: "cannot_modify_owner" });
    return;
  }

  const staffId = parsed.data.staffId;
  if (staffId) {
    const chair = await forShop(shopId).staff.findFirst({
      where: { id: staffId, active: true },
      select: { id: true },
    });
    if (!chair) {
      res.status(400).json({ error: "invalid_staff" });
      return;
    }
    const claimed = await prisma.shopMember.findFirst({
      where: { staffId, id: { not: member.id } },
      select: { id: true },
    });
    if (claimed) {
      res.status(409).json({ error: "staff_taken" });
      return;
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.shopMember.update({
      where: { id: member.id },
      data: {
        ...(parsed.data.role ? { role: parsed.data.role } : {}),
        ...(staffId !== undefined ? { staffId } : {}),
      },
    });
    // Re-point Staff.userId whenever the chair link moves, so this seat's
    // bookings alert THIS person instead of falling back to the owner. Skipped
    // when the request didn't touch staffId (a role-only edit). Same
    // transaction as the seat write: the two must never disagree.
    if (staffId !== undefined) {
      await applyChairLink(tx, {
        shopId,
        userId: member.userId,
        previousStaffId: member.staffId,
        nextStaffId: staffId,
      });
    }
  });
  res.json({ ok: true });
});

/** A public chair name from a person's name - never an email address. */
function chairName(personName: string, shop: Parameters<typeof vocabularyForShop>[0]): string {
  const name = personName.trim();
  if (name && !name.includes("@")) return name.slice(0, 120);
  const noun = vocabularyForShop(shop).providerNoun;
  return `New ${noun}`;
}

/**
 * POST /api/team/members/:id/staff — give someone on the team a chair of their own.
 *
 * The dead end this closes: a barber who joined without a chair is told "Ask the
 * shop owner to link your login to your chair on the Team page", and the Team
 * page could only link chairs that already existed - so an owner onboarding a
 * whole team had to leave for Booking → Staff, create each chair, and come back.
 * Here it is one step: a new active chair named after them, offered for every
 * "offered by all" service, linked to their seat. Their hours are set the same
 * way as any new chair's.
 */
teamRouter.post("/members/:id/staff", requireOwner, async (req, res) => {
  const shopId = req.shop!.id;
  const member = await prisma.shopMember.findFirst({
    where: { id: req.params.id, shopId },
    select: {
      id: true,
      userId: true,
      staffId: true,
      user: { select: { name: true, avatarUrl: true } },
    },
  });
  if (!member) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (member.userId === req.shop!.ownerId) {
    res.status(409).json({ error: "cannot_modify_owner" });
    return;
  }
  if (member.staffId) {
    res.status(409).json({ error: "already_has_chair" });
    return;
  }

  let staffId: string;
  try {
    staffId = await prisma.$transaction(async (tx) => {
      const chair = await tx.staff.create({
        data: {
          shopId,
          // The chair's name is PUBLIC (the booking page). Some accounts carry
          // an email address as their name (Apple sign-in without a name), and
          // that must never be published - the owner renames it under Staff.
          name: chairName(member.user.name, req.shop!),
          // Only an http(s) photo, the same boundary the staff editor enforces.
          imageUrl:
            member.user.avatarUrl && /^https?:\/\//i.test(member.user.avatarUrl)
              ? member.user.avatarUrl
              : null,
          active: true,
        },
        select: { id: true },
      });
      // Conditional on the seat STILL having no chair, so a double-tap can't
      // leave a second, orphaned chair behind: the loser matches nothing and
      // its chair is rolled back with it.
      const linked = await tx.shopMember.updateMany({
        where: { id: member.id, shopId, staffId: null },
        data: { staffId: chair.id },
      });
      if (linked.count === 0) throw new Error("already_has_chair");
      await applyChairLink(tx, {
        shopId,
        userId: member.userId,
        previousStaffId: null,
        nextStaffId: chair.id,
      });
      return chair.id;
    });
  } catch (err) {
    if (err instanceof Error && err.message === "already_has_chair") {
      res.status(409).json({ error: "already_has_chair" });
      return;
    }
    throw err;
  }
  // After the commit, like the staff editor's create: a chair is real without
  // its services, it just isn't offered for "all" of them until this lands.
  await linkStaffToOfferedByAllServices(shopId, staffId);
  res.status(201).json({ ok: true, staffId });
});

/**
 * DELETE /api/team/members/:id — take away someone's access.
 *
 * Removes the SEAT, never the Staff row: their chair, hours and appointment
 * history stay exactly as they are, so revoking access can't quietly rewrite
 * the calendar. (Deactivating the chair is a separate, existing action.)
 */
teamRouter.delete("/members/:id", requireOwner, async (req, res) => {
  const shopId = req.shop!.id;
  const member = await prisma.shopMember.findFirst({
    where: { id: req.params.id, shopId },
    select: { id: true, userId: true, staffId: true },
  });
  if (!member) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (member.userId === req.shop!.ownerId) {
    res.status(409).json({ error: "cannot_remove_owner" });
    return;
  }
  await prisma.$transaction(async (tx) => {
    await tx.shopMember.delete({ where: { id: member.id } });
    // Their chair, hours and history stay exactly as they are (see above) -
    // but the LOGIN link goes with the seat, so alerts for that chair fall
    // back to the owner rather than pinging someone who no longer has access.
    await releaseChairLink(tx, {
      shopId,
      userId: member.userId,
      staffId: member.staffId,
    });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// INDEPENDENT BUSINESSES on this shop's team (TeamLink). The owner shares one
// link, approves who joins, and sees each member's numbers - only the ones
// that member shares (services/teamLinks.ts decides; this never widens it).
// Owner-only: the members share with the shop's OWNER, not with its managers.
// ---------------------------------------------------------------------------

/** GET /api/team/links - the team link to share, requests waiting, and the team. */
teamRouter.get("/links", requireOwner, async (req, res) => {
  const shop = req.shop!;
  const links = await linksForTeam(shop.id);
  const now = new Date();
  const card = (l: (typeof links)[number]) => ({
    id: l.id,
    business: { name: l.memberShop.name, logoUrl: l.memberShop.logoUrl },
    ownerName: l.memberShop.owner.name,
  });
  res.json({
    // The shop's id, never its web address: an address can be changed and
    // then taken by another shop, and an old link would ask to join THAT one.
    joinUrl: `${env.APP_BASE_URL}/team/link/${encodeURIComponent(shop.id)}`,
    pending: links
      .filter((l) => l.status === "PENDING")
      .map((l) => ({ ...card(l), requestedAt: l.requestedAt.toISOString() })),
    active: await Promise.all(
      links
        .filter((l) => l.status === "ACTIVE")
        .map(async (l) => ({
          ...card(l),
          approvedAt: l.approvedAt?.toISOString() ?? null,
          sharing: sharingOf(l),
          numbers: await teamNumbers(l.memberShop, sharingOf(l), now),
          // Booth rent is the owner's own ledger with this member, not one of
          // the member's numbers - so it's always shown to the owner.
          rent: await runAsOwner((tx) => rentSummary(tx, l, shop.timezone, now)),
        })),
    ),
  });
});

/** POST /api/team/links/:id/approve - let a business that asked onto the team. */
teamRouter.post("/links/:id/approve", accountLimiter, requireOwner, async (req, res) => {
  const shop = req.shop!;
  const approved = await runAsOwner(async (tx) => {
    // Only a link to THIS shop, and only while it is still waiting: a double
    // tap, or a request withdrawn a moment ago, matches nothing.
    const { count } = await tx.teamLink.updateMany({
      where: { id: req.params.id, teamShopId: shop.id, status: "PENDING" },
      data: { status: "ACTIVE", approvedAt: new Date() },
    });
    if (count === 0) return null;
    return tx.teamLink.findUnique({
      where: { id: req.params.id },
      select: { memberShop: { select: { name: true, owner: { select: { email: true } } } } },
    });
  });
  if (!approved) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (emailEnabled()) {
    try {
      await sendEmail({
        to: approved.memberShop.owner.email,
        subject: `You're on ${shop.name}'s team`,
        text: [
          `${shop.name} approved ${approved.memberShop.name} for their team on ${APP_NAME}.`,
          "",
          // Not "they see nothing": a barber can turn sharing on while waiting.
          "Your clients, bookings and payments stay yours. They see only what you choose to share - check or change it here:",
          `${env.APP_BASE_URL}/dashboard/teams`,
        ].join("\n"),
      });
    } catch (err) {
      logger.warn({ err, teamShopId: shop.id }, "team approval email failed");
    }
  }
  res.json({ ok: true });
});

/**
 * POST /api/team/links/:id/end - decline a request, or take someone off the
 * team. Their business is untouched; their share switches go back to off.
 */
teamRouter.post("/links/:id/end", accountLimiter, requireOwner, async (req, res) => {
  const { count } = await runAsOwner((tx) =>
    tx.teamLink.updateMany({
      where: {
        id: req.params.id,
        teamShopId: req.shop!.id,
        status: { in: ["PENDING", "ACTIVE"] },
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

// ---- BOOTH RENT: an amount per week or month, and payments the owner records.

/** An ACTIVE member of THIS shop's team. */
function activeMember(tx: Prisma.TransactionClient, shopId: string, linkId: string) {
  return tx.teamLink.findFirst({
    where: { id: linkId, teamShopId: shopId, status: "ACTIVE" },
    select: { id: true, rentCents: true, rentPeriod: true },
  });
}

const rentSchema = z
  .object({
    // Null turns rent off.
    amountCents: z.number().int().min(1).max(10_000_000).nullable(),
    period: z.enum(["WEEKLY", "MONTHLY"]).optional(),
  })
  .strict()
  .refine((v) => v.amountCents === null || v.period !== undefined);

/** PUT /api/team/links/:id/rent - set, change or turn off a member's rent. */
teamRouter.put("/links/:id/rent", accountLimiter, requireOwner, async (req, res) => {
  const parsed = rentSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const shop = req.shop!;
  const rent = await runAsOwner(async (tx) => {
    const link = await activeMember(tx, shop.id, req.params.id!);
    if (!link) return null;
    const next = {
      rentCents: parsed.data.amountCents,
      rentPeriod: parsed.data.amountCents === null ? null : parsed.data.period!,
    };
    await tx.teamLink.update({ where: { id: link.id }, data: next });
    return rentSummary(tx, { id: link.id, ...next }, shop.timezone);
  });
  if (!rent) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true, rent });
});

const paymentSchema = z
  .object({
    amountCents: z.number().int().min(1).max(10_000_000),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    method: z.enum(PAYMENT_METHODS),
    note: z.string().trim().max(200).optional(),
    // The form's one-time id: a retried submit records one payment.
    clientRef: z.string().min(8).max(64),
  })
  .strict();

/** POST /api/team/links/:id/rent/payments - record rent the owner received. */
teamRouter.post("/links/:id/rent/payments", accountLimiter, requireOwner, async (req, res) => {
  const parsed = paymentSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const shop = req.shop!;
  const paidOn = new Date(`${parsed.data.date}T00:00:00Z`);
  // A real day, and not one that hasn't happened yet in the shop.
  if (
    Number.isNaN(paidOn.getTime()) ||
    paidOn.toISOString().slice(0, 10) !== parsed.data.date ||
    paidOn > shopLocalDay(new Date(), shop.timezone)
  ) {
    res.status(400).json({ error: "invalid_date" });
    return;
  }
  const rent = await runAsOwner(async (tx) => {
    const link = await activeMember(tx, shop.id, req.params.id!);
    if (!link) return null;
    await tx.boothRentPayment.createMany({
      data: [
        {
          linkId: link.id,
          amountCents: parsed.data.amountCents,
          paidOn,
          method: parsed.data.method,
          note: parsed.data.note || null,
          recordedById: req.userId!,
          clientRef: parsed.data.clientRef,
        },
      ],
      skipDuplicates: true, // same clientRef = the same payment, sent again
    });
    return rentSummary(tx, link, shop.timezone);
  });
  if (!rent) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.status(201).json({ ok: true, rent });
});

/** DELETE /api/team/links/:id/rent/payments/:paymentId - remove a payment recorded by mistake. */
teamRouter.delete("/links/:id/rent/payments/:paymentId", accountLimiter, requireOwner, async (req, res) => {
  const shop = req.shop!;
  const rent = await runAsOwner(async (tx) => {
    const link = await activeMember(tx, shop.id, req.params.id!);
    if (!link) return null;
    const { count } = await tx.boothRentPayment.deleteMany({
      where: { id: req.params.paymentId, linkId: link.id },
    });
    return count === 0 ? null : rentSummary(tx, link, shop.timezone);
  });
  if (!rent) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true, rent });
});

/** GET /api/team/links/:id/rent - every payment from one member. */
teamRouter.get("/links/:id/rent", requireOwner, async (req, res) => {
  const shop = req.shop!;
  const result = await runAsOwner(async (tx) => {
    const link = await tx.teamLink.findFirst({
      where: { id: req.params.id, teamShopId: shop.id },
      select: { id: true, rentCents: true, rentPeriod: true },
    });
    if (!link) return null;
    return { summary: await rentSummary(tx, link, shop.timezone), payments: await rentPayments(tx, link.id) };
  });
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(result);
});
