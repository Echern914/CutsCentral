import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@chairback/db";
import { requireUser } from "../middleware/auth.js";
import { accountLimiter } from "../middleware/rateLimit.js";
import { applyChairLink } from "../services/staffUserLink.js";

/**
 * Accepting a team invitation.
 *
 * Deliberately NOT on teamRouter: that router runs requireShop, and the whole
 * point here is a signed-in user who has NO shop yet. This one needs only a
 * session.
 *
 * Security properties (mirroring passwordReset.ts's redeem):
 *  - the token is looked up by sha256 — the raw value exists only in the email,
 *  - the invited EMAIL must match the signed-in user's, so forwarding the link
 *    to someone else gives them nothing,
 *  - acceptance is claimed ATOMICALLY (updateMany on the still-pending
 *    predicate), so two racing redeems can't both create a seat, and
 *  - expired / revoked / already-accepted all answer the same 410 as an unknown
 *    token: a stranger who guesses learns nothing about which shops exist.
 */
export const teamJoinRouter: Router = Router();

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const tokenSchema = z.object({ token: z.string().min(10).max(200) }).strict();

/**
 * GET /api/team/join/preview?token=… — what am I accepting?
 *
 * Lets the join page say "Drick's Barbershop invited you as a Barber" before
 * the user commits, and flag an email mismatch while it is still fixable
 * (sign in as the invited address) instead of after a confusing failure.
 */
teamJoinRouter.get("/preview", accountLimiter, requireUser, async (req, res) => {
  const parsed = tokenSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const invite = await prisma.teamInvite.findUnique({
    where: { tokenHash: sha256Hex(parsed.data.token) },
    select: {
      email: true,
      role: true,
      acceptedAt: true,
      revokedAt: true,
      expiresAt: true,
      shop: { select: { name: true } },
    },
  });
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { email: true },
  });
  const emailMatches =
    invite !== null &&
    (user?.email ?? "").toLowerCase() === invite.email.toLowerCase();

  if (
    !invite ||
    invite.acceptedAt !== null ||
    invite.revokedAt !== null ||
    invite.expiresAt <= new Date()
  ) {
    // WHY A REASON IS SAFE TO GIVE HERE, when the original blanket 410 gave
    // none. The concern was a stranger probing which invitations exist. That
    // stranger would now need BOTH the 32-byte token AND to be signed in as the
    // address it was sent to - at which point they are the invitee and learn
    // nothing they didn't already have. Everyone else still gets the same
    // opaque answer. The payoff is a screen that says "this expired, ask for a
    // new one" instead of a shrug, which is the difference between a barber
    // texting their boss and a barber giving up.
    const reason = !invite
      ? undefined
      : !emailMatches
        ? undefined
        : invite.revokedAt !== null
          ? "revoked"
          : invite.acceptedAt !== null
            ? "used"
            : "expired";
    res.status(410).json({ error: "invite_invalid", ...(reason ? { reason } : {}) });
    return;
  }
  res.json({
    shopName: invite.shop.name,
    role: invite.role,
    email: invite.email,
    // The join page uses this to say "you're signed in as X, but this invite
    // is for Y" rather than letting them press a button that will 403.
    emailMatches,
  });
});

/** POST /api/team/join — redeem the token and create the seat. */
teamJoinRouter.post("/", accountLimiter, requireUser, async (req, res) => {
  const parsed = tokenSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const tokenHash = sha256Hex(parsed.data.token);
  const invite = await prisma.teamInvite.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      shopId: true,
      email: true,
      role: true,
      staffId: true,
      acceptedAt: true,
      revokedAt: true,
      expiresAt: true,
    },
  });
  if (
    !invite ||
    invite.acceptedAt !== null ||
    invite.revokedAt !== null ||
    invite.expiresAt <= new Date()
  ) {
    res.status(410).json({ error: "invite_invalid" });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { id: true, email: true },
  });
  if (!user || user.email.toLowerCase() !== invite.email.toLowerCase()) {
    // The invite is real but belongs to someone else — say so plainly so the
    // recipient knows to sign in with the invited address.
    res.status(403).json({ error: "email_mismatch", invitedEmail: invite.email });
    return;
  }

  // A chair can only be claimed once. Checked here (and enforced by the unique
  // index) so a stale invite naming a since-taken chair joins WITHOUT the link
  // rather than failing outright — access is the point; the owner can relink.
  let staffId = invite.staffId;
  if (staffId) {
    const claimed = await prisma.shopMember.findFirst({
      where: { staffId },
      select: { id: true },
    });
    if (claimed) staffId = null;
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Claim the invite atomically: only the racer that flips a still-pending
      // row proceeds, so a double-click can't create two seats.
      const claim = await tx.teamInvite.updateMany({
        where: { id: invite.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: new Date() },
      });
      if (claim.count === 0) throw new Error("invite_race");
      await tx.shopMember.create({
        data: {
          shopId: invite.shopId,
          userId: user.id,
          role: invite.role,
          staffId,
        },
      });
      // Mirror the seat->chair link onto Staff.userId in the SAME transaction,
      // so a barber whose invite named a chair is reachable by their own
      // alerts from the moment they accept - not from the next time an owner
      // happens to re-save the seat. See services/staffUserLink.ts.
      await applyChairLink(tx, {
        shopId: invite.shopId,
        userId: user.id,
        previousStaffId: null,
        nextStaffId: staffId,
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message === "invite_race") {
      res.status(410).json({ error: "invite_invalid" });
      return;
    }
    // Unique (shopId, userId): they already had a seat. Treat as success —
    // they have the access the link promised.
    res.status(409).json({ error: "already_member" });
    return;
  }
  res.status(201).json({ ok: true, shopId: invite.shopId });
});
