import { createHash } from "node:crypto";
import { APP_NAME, apiEnv, randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import { sendEmail } from "../messaging/email.js";
import { logger } from "../logger.js";

/**
 * WRITING AND SENDING ONE TEAM INVITATION - shared by the Team page's invite
 * form (routes/team.ts) and first-time setup, where an owner can add an email
 * beside each person they name (routes/onboarding.ts).
 *
 * One function so the two can never mint different invitations: the same
 * one-shot hashed token, the same seven days, the same "one live invitation per
 * address per shop", the same email. The threat model is written out on
 * routes/team.ts.
 *
 * The CHECKS stay with the caller, because they answer differently in each
 * place: the Team page refuses a person already on the team, setup just skips
 * them. What both must do before calling this:
 *   - confirm email is configured (`emailEnabled()`), since no token is minted
 *     that could never be delivered, and
 *   - confirm any chair named belongs to this shop and is not already claimed.
 */

const env = apiEnv();

/** A week: long enough for someone to get to it, short enough to bound a stale mailbox. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function inviteTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function sendTeamInvite(input: {
  shopId: string;
  shopName: string;
  /** Already trimmed and lowercased by the caller. */
  email: string;
  role: "MANAGER" | "BARBER";
  staffId: string | null;
  invitedById: string;
}): Promise<"sent" | "email_failed"> {
  const { shopId, shopName, email } = input;
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
        role: input.role,
        staffId: input.staffId,
        tokenHash: inviteTokenHash(token),
        invitedById: input.invitedById,
        expiresAt,
      },
    }),
  ]);

  const acceptUrl = `${env.APP_BASE_URL}/team/join?token=${encodeURIComponent(token)}`;
  try {
    await sendEmail({
      to: email,
      subject: `${shopName} invited you to ${APP_NAME}`,
      text: [
        `${shopName} added you to their team on ${APP_NAME}.`,
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
    // The invite row is already written; the caller surfaces the send failure
    // so the owner can retry rather than believing an email went out.
    logger.error({ err, shopId }, "team invite email failed");
    return "email_failed";
  }
  return "sent";
}
