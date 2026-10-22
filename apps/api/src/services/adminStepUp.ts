import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { APP_NAME, apiEnv } from "@chairback/config";
import { prisma, runAsOwner } from "@chairback/db";
import { logger } from "../logger.js";
import { emailEnabled, sendEmail } from "../messaging/email.js";
import { codeShapeOk, mintCode } from "../engines/otpPolicy.js";
import { newTotpSecret, otpauthUri, verifyTotp } from "../auth/totp.js";
import { openToken, purposeKeys, sealToken } from "./tokenKey.js";

/**
 * ADMIN TWO-STEP. The operator portal shows every shop and every owner's
 * email, and can change platform switches. Until this, the only thing between
 * a session and all of it was `isAdmin` on the session's user - so a stolen
 * session, or one FORGED with a leaked SESSION_SECRET (the secret sits in the
 * hosting environment), was the whole portal.
 *
 * Now a session also has to pass a second check before the portal opens:
 *   - an authenticator-app code (TOTP) - the main way;
 *   - a code emailed to the admin's login address - the fallback, and the
 *     gate in front of setting an authenticator up.
 * A pass is bound to TWO things and lasts 12 hours:
 *   - the session token's digest (`req.sessionDigest`);
 *   - a random PASS TOKEN, returned when the code is accepted and kept by the
 *     web in an httpOnly cookie (ADMIN_PASS_COOKIE_NAME).
 * Why both: a session token is {userId, iat, exp} signed with SESSION_SECRET,
 * so whoever holds that secret can mint a byte-identical copy of the admin's
 * live session by trying each second of its issue time - the session digest
 * alone would hand them its pass. The pass token comes from the server's RNG
 * and exists only as a hash here; no key can produce it.
 *
 * Every pass emails the admin, so a sign-in that was not theirs is noticed.
 * ADMIN_STEP_UP_ENABLED=false is the escape hatch (env.ts).
 */

export const STEP_UP_TTL_MS = 12 * 60 * 60 * 1000;
export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
export const EMAIL_CODES_PER_HOUR = 5;

const CODE_PURPOSE = "admin_email_code_v1";

/**
 * A code at rest is a KEYED digest, so a copy of the database alone cannot
 * be brute-forced back to the six digits inside its ten minutes.
 */
function codeDigests(userId: string, code: string): string[] {
  return purposeKeys(CODE_PURPOSE).map((k) =>
    createHmac("sha256", k).update(`${userId}:${code}`, "utf8").digest("hex"),
  );
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

export function stepUpRequired(): boolean {
  return apiEnv().ADMIN_STEP_UP_ENABLED;
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(6, local.length - 2)))}@${domain}`;
}

export function passHashOf(passToken: string): string {
  return createHash("sha256").update(passToken, "utf8").digest("hex");
}

/** When this session's pass ends, or null when it has none. Needs BOTH halves. */
export async function liveStepUpUntil(
  userId: string,
  sessionDigest: string,
  passToken: string | null,
  now: Date,
): Promise<Date | null> {
  if (!passToken) return null;
  const row = await runAsOwner((tx) =>
    tx.adminStepUp.findFirst({
      where: { userId, sessionDigest, passHash: passHashOf(passToken), expiresAt: { gt: now } },
      orderBy: { expiresAt: "desc" },
      select: { expiresAt: true },
    }),
  );
  return row?.expiresAt ?? null;
}

export interface TwoStepStatus {
  required: boolean;
  passedUntil: string | null;
  totpEnabled: boolean;
  emailAvailable: boolean;
  email: string | null;
}

export async function twoStepStatus(
  userId: string,
  sessionDigest: string,
  passToken: string | null,
  now: Date,
): Promise<TwoStepStatus> {
  const [user, until] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true, adminTotpEnabledAt: true } }),
    liveStepUpUntil(userId, sessionDigest, passToken, now),
  ]);
  return {
    required: stepUpRequired(),
    passedUntil: until?.toISOString() ?? null,
    totpEnabled: Boolean(user?.adminTotpEnabledAt),
    emailAvailable: emailEnabled(),
    email: user?.email ? maskEmail(user.email) : null,
  };
}

/** "an iPhone", "a Mac", ... - enough for the admin to recognise the device. */
export function deviceFrom(userAgent: string | null): string {
  const ua = userAgent ?? "";
  if (/ChairBack/i.test(ua)) return "the ChairBack app";
  if (/iPhone/i.test(ua)) return "an iPhone";
  if (/iPad/i.test(ua)) return "an iPad";
  if (/Android/i.test(ua)) return "an Android phone";
  if (/Macintosh|Mac OS X/i.test(ua)) return "a Mac";
  if (/Windows/i.test(ua)) return "a Windows computer";
  return "a device we couldn't identify";
}

async function recordPass(input: {
  userId: string;
  sessionDigest: string;
  method: "totp" | "email";
  userAgent: string | null;
  now: Date;
}): Promise<{ until: Date; passToken: string }> {
  const until = new Date(input.now.getTime() + STEP_UP_TTL_MS);
  const passToken = randomBytes(32).toString("base64url");
  await runAsOwner((tx) =>
    tx.adminStepUp.create({
      data: {
        userId: input.userId,
        sessionDigest: input.sessionDigest,
        passHash: passHashOf(passToken),
        method: input.method,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
        expiresAt: until,
      },
    }),
  );
  logger.info({ userId: input.userId, method: input.method }, "admin two-step passed");
  void alertAdmin(input.userId, input.method, input.userAgent, input.now);
  return { until, passToken };
}

/** "ChairBack admin was opened" - never fatal, never logged with the address. */
async function alertAdmin(userId: string, method: "totp" | "email", userAgent: string | null, now: Date): Promise<void> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user?.email || !emailEnabled()) return;
    const when = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(now);
    await sendEmail({
      to: user.email,
      subject: `${APP_NAME} admin was opened`,
      text: [
        `Your ${APP_NAME} admin was opened on ${when} (Eastern), from ${deviceFrom(userAgent)}, using ${
          method === "totp" ? "your authenticator app" : "a code we emailed you"
        }.`,
        "",
        "If that was you, there's nothing to do.",
        "",
        "If it wasn't: change your password right away, and turn on two-step sign-in for this email account.",
      ].join("\n"),
    });
  } catch (err) {
    logger.warn({ err, userId }, "admin two-step alert email failed");
  }
}

export type StartEmailResult =
  | { ok: true; sentTo: string }
  | { ok: false; reason: "email_unavailable" | "too_many" | "send_failed" };

export async function startEmailCode(userId: string, now: Date): Promise<StartEmailResult> {
  if (!emailEnabled()) return { ok: false, reason: "email_unavailable" };
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user?.email) return { ok: false, reason: "email_unavailable" };
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const recent = await runAsOwner((tx) =>
    tx.adminEmailCode.count({ where: { userId, createdAt: { gt: hourAgo } } }),
  );
  if (recent >= EMAIL_CODES_PER_HOUR) return { ok: false, reason: "too_many" };

  const code = mintCode();
  const row = await runAsOwner(async (tx) => {
    // One live code at a time: a new one retires the last.
    await tx.adminEmailCode.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: now },
    });
    return tx.adminEmailCode.create({
      data: {
        userId,
        codeHash: codeDigests(userId, code)[0]!,
        expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS),
      },
      select: { id: true },
    });
  });
  try {
    await sendEmail({
      to: user.email,
      subject: `Your ${APP_NAME} admin code: ${code}`,
      text: [
        `Your ${APP_NAME} admin code is ${code}. It works for 10 minutes.`,
        "",
        `If you didn't just try to open the ${APP_NAME} admin, someone may have your password - change it now.`,
      ].join("\n"),
    });
  } catch (err) {
    logger.warn({ err, userId }, "admin two-step code email failed");
    await runAsOwner((tx) => tx.adminEmailCode.updateMany({ where: { id: row.id }, data: { consumedAt: now } }));
    return { ok: false, reason: "send_failed" };
  }
  return { ok: true, sentTo: maskEmail(user.email) };
}

export type VerifyResult =
  | { ok: true; until: Date; passToken: string }
  | { ok: false; reason: "invalid" | "expired" | "too_many_attempts" | "not_set_up" };

export async function verifyEmailCode(input: {
  userId: string;
  sessionDigest: string;
  code: string;
  userAgent: string | null;
  now: Date;
}): Promise<VerifyResult> {
  if (!codeShapeOk(input.code)) return { ok: false, reason: "invalid" };
  const row = await runAsOwner((tx) =>
    tx.adminEmailCode.findFirst({
      where: { userId: input.userId, consumedAt: null, expiresAt: { gt: input.now } },
      orderBy: { createdAt: "desc" },
      select: { id: true, codeHash: true, attempts: true },
    }),
  );
  if (!row) return { ok: false, reason: "expired" };
  // Count the try BEFORE comparing, as a compare-and-swap, so parallel guesses
  // cannot share one attempt.
  const counted = await runAsOwner((tx) =>
    tx.adminEmailCode.updateMany({
      where: { id: row.id, consumedAt: null, attempts: { lt: EMAIL_CODE_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    }),
  );
  if (counted.count === 0) return { ok: false, reason: "too_many_attempts" };
  if (!codeDigests(input.userId, input.code).some((d) => sameHex(d, row.codeHash))) {
    return { ok: false, reason: "invalid" };
  }
  const consumed = await runAsOwner((tx) =>
    tx.adminEmailCode.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: input.now } }),
  );
  if (consumed.count === 0) return { ok: false, reason: "expired" };
  const pass = await recordPass({ ...input, method: "email" });
  return { ok: true, ...pass };
}

export async function verifyTotpCode(input: {
  userId: string;
  sessionDigest: string;
  code: string;
  userAgent: string | null;
  now: Date;
}): Promise<VerifyResult> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { adminTotpSecretEnc: true, adminTotpEnabledAt: true, adminTotpLastStep: true },
  });
  if (!user?.adminTotpSecretEnc || !user.adminTotpEnabledAt) return { ok: false, reason: "not_set_up" };
  const check = verifyTotp(openToken(user.adminTotpSecretEnc), input.code, input.now, user.adminTotpLastStep);
  if (!check.ok) return { ok: false, reason: "invalid" };
  // Spend the step as a compare-and-swap: the same code, sent twice at once,
  // passes once.
  const spent = await prisma.user.updateMany({
    where: {
      id: input.userId,
      OR: [{ adminTotpLastStep: null }, { adminTotpLastStep: { lt: check.step } }],
    },
    data: { adminTotpLastStep: check.step },
  });
  if (spent.count === 0) return { ok: false, reason: "invalid" };
  const pass = await recordPass({ ...input, method: "totp" });
  return { ok: true, ...pass };
}

/** Start (or redo) authenticator setup: a fresh secret, held until confirmed. */
export async function beginTotpSetup(userId: string): Promise<{ secret: string; otpauthUri: string } | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) return null;
  const secret = newTotpSecret();
  await prisma.user.update({ where: { id: userId }, data: { adminTotpPendingEnc: sealToken(secret) } });
  return { secret, otpauthUri: otpauthUri({ secret, account: user.email, issuer: `${APP_NAME} admin` }) };
}

/** Confirm setup with a code from the app; only then does it replace the old one. */
export async function confirmTotpSetup(
  userId: string,
  code: string,
  now: Date,
): Promise<{ ok: true } | { ok: false; reason: "no_pending" | "invalid" }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { adminTotpPendingEnc: true } });
  if (!user?.adminTotpPendingEnc) return { ok: false, reason: "no_pending" };
  const check = verifyTotp(openToken(user.adminTotpPendingEnc), code, now, null);
  if (!check.ok) return { ok: false, reason: "invalid" };
  const done = await prisma.user.updateMany({
    where: { id: userId, adminTotpPendingEnc: user.adminTotpPendingEnc },
    data: {
      adminTotpSecretEnc: user.adminTotpPendingEnc,
      adminTotpPendingEnc: null,
      adminTotpEnabledAt: now,
      adminTotpLastStep: check.step,
    },
  });
  if (done.count === 0) return { ok: false, reason: "no_pending" };
  logger.info({ userId }, "admin authenticator set up");
  return { ok: true };
}
