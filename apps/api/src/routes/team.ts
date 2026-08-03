import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { APP_NAME, apiEnv, randomToken } from "@chairback/config";
import { forShop, prisma } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireManager, requireOwner } from "../auth/roles.js";
import { accountLimiter, dashboardLimiter } from "../middleware/rateLimit.js";
import { emailEnabled, sendEmail } from "../messaging/email.js";
import { logger } from "../logger.js";

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
teamRouter.use(requireUser, requireShop, requireManager);

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
    select: { id: true, userId: true, role: true },
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

  await prisma.shopMember.update({
    where: { id: member.id },
    data: {
      ...(parsed.data.role ? { role: parsed.data.role } : {}),
      ...(staffId !== undefined ? { staffId } : {}),
    },
  });
  res.json({ ok: true });
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
    select: { id: true, userId: true },
  });
  if (!member) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (member.userId === req.shop!.ownerId) {
    res.status(409).json({ error: "cannot_remove_owner" });
    return;
  }
  await prisma.shopMember.delete({ where: { id: member.id } });
  res.json({ ok: true });
});
