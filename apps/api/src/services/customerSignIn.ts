import { createHmac } from "node:crypto";
import { Prisma, runAsOwner } from "@chairback/db";
import { apiEnv, isLikelyEmail } from "@chairback/config";
import { toE164 } from "../acuity/clientKey.js";
import { getMessageProvider } from "../messaging/twilio.js";
import { sendEmail } from "../messaging/email.js";
import { logger } from "../logger.js";
import {
  CLEANUP_AFTER_MS,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  codeShapeOk,
  digestsMatch,
  hashOtp,
  mintCode,
} from "../engines/otpPolicy.js";
import {
  billableSegments,
  positiveCapFromEnv,
  takeWindowedBudget,
} from "./recoverySmsBudget.js";

/**
 * My ChairBack sign-in: prove you hold a phone or an email with a six-digit
 * code. Proof is the ONLY way an account comes to exist or a session gets
 * minted (services/customerIdentity.ts takes it from here).
 *
 * The shape is rewards recovery's, deliberately (services/rewardsRecovery.ts):
 * one engine, the shared OTP policy, an HMAC'd identifier as the only lookup
 * key, per-identifier and per-IP ceilings counted on the table under an
 * advisory lock, a platform budget reserved BEFORE any send and never given
 * back, a fire-and-forget send so a known and an unknown identifier cannot be
 * told apart by timing a provider call, and classification-only failure
 * handling - the thrown value from a provider may carry the destination, the
 * code or a credential, so it never reaches a log line.
 *
 * ONE deliberate difference from recovery: a phone ChairBack has never seen
 * CAN receive a code. Recovery exists to find records that already exist, so
 * it rightly refuses unknown numbers; sign-in is also how a brand-new customer
 * gets in, and their empty home is a real answer. The price is paid in
 * ceilings instead: US/Canada numbers only (the international routes are
 * where SMS-pumping fraud lives), a platform text budget of its own that
 * fails closed, and the per-number and per-IP caps below. Email is always
 * available and costs next to nothing.
 */

export type SignInChannel = "sms" | "email";

const PURPOSE = "customer_sign_in" as const;

/** Challenges one IP may mint across ALL identifiers per window. */
export const SIGNIN_IP_CAP = 10;
export const SIGNIN_IP_WINDOW_MS = 10 * 60 * 1000;

/** Per-identifier sends per rolling day. Texts cost money; emails cost reputation. */
export const SIGNIN_MAX_SENDS_PER_DAY: Record<SignInChannel, number> = { sms: 3, email: 5 };
export const SIGNIN_SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export const SIGNIN_SMS_HOURLY_CAP_DEFAULT = 100;
export const SIGNIN_SMS_DAILY_CAP_DEFAULT = 500;
export const SIGNIN_EMAIL_HOURLY_CAP_DEFAULT = 300;
export const SIGNIN_EMAIL_DAILY_CAP_DEFAULT = 2000;

/** Purpose-tagged key, derived from the existing secret (no new env var to forget). */
function hmacKey(): string {
  return `${apiEnv().TOKEN_ENCRYPTION_KEY}:customer_sign_in_hmac_v1`;
}

export function identifierDigest(channel: SignInChannel, identifier: string): string {
  return createHmac("sha256", hmacKey()).update(`${channel}:${identifier}`, "utf8").digest("hex");
}

function ipDigest(ip: string): string {
  return createHmac("sha256", hmacKey()).update(`ip:${ip}`, "utf8").digest("hex");
}

/** The digest scope folds the channel in, so a text code never redeems as an email code. */
function codeDigest(channel: SignInChannel, identifier: string, code: string): string {
  return hashOtp(`${PURPOSE}:${channel}`, identifier, PURPOSE, code);
}

/**
 * Normalize a typed phone for SIGN-IN: valid E.164 AND North American. Null
 * for anything else - the route then says "use your email", never sends.
 */
export function normalizeSignInPhone(raw: string | null | undefined): string | null {
  const e164 = toE164(raw ?? null);
  return e164 && e164.startsWith("+1") ? e164 : null;
}

/** Normalize an email the way Client rows are matched: trimmed, lowercased. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const e = (raw ?? "").trim().toLowerCase();
  if (!e || e.length > 254 || !isLikelyEmail(e)) return null;
  return e;
}

export function signInSmsBody(code: string): string {
  // GSM-7 only, one segment; pinned by a segment test. iOS offers the code
  // straight from the keyboard because the text names it a code.
  return `ChairBack code: ${code}. Use it to sign in to My ChairBack. Expires in 5 minutes. Reply STOP to opt out.`;
}

export function signInEmail(code: string): { subject: string; text: string; html: string } {
  const subject = `Your ChairBack code: ${code}`;
  const text = [
    `Your My ChairBack sign-in code is ${code}.`,
    "",
    "It expires in 5 minutes. If you didn't ask for it, you can ignore this email - nobody can sign in without the code.",
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#17171b;">
<p style="margin:0 0 16px;font-size:15px;">Your My ChairBack sign-in code:</p>
<p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:6px;">${code}</p>
<p style="margin:0;font-size:13px;color:#5a5a62;">It expires in 5 minutes. If you didn't ask for it, you can ignore this email - nobody can sign in without the code.</p>
</div>`;
  return { subject, text, html };
}

function budgetFor(channel: SignInChannel) {
  return channel === "sms"
    ? {
        keyPrefix: "custSms:budget",
        hourlyCap: positiveCapFromEnv("CUSTOMER_SIGNIN_SMS_HOURLY_CAP", SIGNIN_SMS_HOURLY_CAP_DEFAULT),
        dailyCap: positiveCapFromEnv("CUSTOMER_SIGNIN_SMS_DAILY_CAP", SIGNIN_SMS_DAILY_CAP_DEFAULT),
        label: { words: "customer sign-in SMS", code: "customer_signin_sms_budget" },
      }
    : {
        keyPrefix: "custEmail:budget",
        hourlyCap: positiveCapFromEnv("CUSTOMER_SIGNIN_EMAIL_HOURLY_CAP", SIGNIN_EMAIL_HOURLY_CAP_DEFAULT),
        dailyCap: positiveCapFromEnv("CUSTOMER_SIGNIN_EMAIL_DAILY_CAP", SIGNIN_EMAIL_DAILY_CAP_DEFAULT),
        label: { words: "customer sign-in email", code: "customer_signin_email_budget" },
      };
}

export type SignInIssueOutcome =
  | { send: true; code: string }
  /** 🔴 INTERNAL ONLY - never echoed to a response, a log line or a metric. */
  | { send: false; reason: "cooldown" | "identifier_cap" | "ip_cap" | "platform_budget" };

/** Mint (or refresh) the one sign-in challenge for this identifier. */
export async function issueSignInCode(opts: {
  channel: SignInChannel;
  identifier: string;
  ip: string;
  now: Date;
}): Promise<SignInIssueOutcome> {
  const { channel, identifier, ip, now } = opts;
  const identifierHash = identifierDigest(channel, identifier);
  const ipHash = ipDigest(ip);

  return runAsOwner(async (tx) => {
    // Serialize per IP FIRST: the ceiling below is count-then-insert.
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`csi:${ipHash}`}))`);

    // Inline bounded cleanup - there is no scheduled job to seed or forget.
    await tx.customerSignInCode.deleteMany({
      where: { expiresAt: { lt: new Date(now.getTime() - CLEANUP_AFTER_MS) } },
    });

    const fromThisIp = await tx.customerSignInCode.count({
      where: { ipHash, lastSentAt: { gt: new Date(now.getTime() - SIGNIN_IP_WINDOW_MS) } },
    });
    if (fromThisIp >= SIGNIN_IP_CAP) return { send: false, reason: "ip_cap" };

    const existing = await tx.customerSignInCode.findUnique({
      where: { channel_identifierHash: { channel, identifierHash } },
    });
    const inWindow =
      existing !== null && now.getTime() - existing.lastSentAt.getTime() < SIGNIN_SEND_WINDOW_MS;
    if (existing) {
      if (now.getTime() - existing.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
        return { send: false, reason: "cooldown" };
      }
      if (inWindow && existing.sendCount >= SIGNIN_MAX_SENDS_PER_DAY[channel]) {
        return { send: false, reason: "identifier_cap" };
      }
    }

    const code = mintCode();
    // 🔴 THE PLATFORM BREAKER, the last gate before spend is committed.
    // Reserved before dispatch and never given back: an ambiguous provider
    // outcome may still have cost money.
    const units = channel === "sms" ? billableSegments(signInSmsBody(code)) : 1;
    if (!(await takeWindowedBudget(tx, now, units, budgetFor(channel)))) {
      return { send: false, reason: "platform_budget" };
    }

    const fresh = {
      codeHash: codeDigest(channel, identifier, code),
      ipHash,
      attemptCount: 0,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      consumedAt: null,
      lastSentAt: now,
    };
    if (existing) {
      await tx.customerSignInCode.update({
        where: { id: existing.id },
        data: { ...fresh, sendCount: inWindow ? existing.sendCount + 1 : 1 },
      });
      return { send: true, code };
    }
    try {
      await tx.customerSignInCode.create({ data: { channel, identifierHash, ...fresh } });
    } catch (err) {
      // A raced double-create collapses on the unique index: literally a cooldown.
      if ((err as { code?: string }).code === "P2002") return { send: false, reason: "cooldown" };
      throw err;
    }
    return { send: true, code };
  });
}

/**
 * THE one entry the route calls. Answers nothing about the identifier: every
 * path resolves the same way, and the send happens after the caller has
 * already responded. NO RETRY, EVER - retrying an ambiguous send is how one
 * customer gets three texts.
 */
export async function requestSignInCode(opts: {
  channel: SignInChannel;
  identifier: string;
  ip: string;
  now: Date;
}): Promise<void> {
  const outcome = await issueSignInCode(opts);
  if (!outcome.send) return;
  const { channel, identifier } = opts;
  const code = outcome.code;

  void (async () => {
    try {
      if (channel === "sms") {
        await getMessageProvider().send({ to: identifier, body: signInSmsBody(code) });
      } else {
        const mail = signInEmail(code);
        await sendEmail({
          to: identifier,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          meta: { kind: "customer_sign_in" },
        });
      }
    } catch {
      // 🔴 Fixed classification only - the thrown value may carry the phone,
      // the address, the code, the body or a credential.
      logger.warn({ channel }, "customer sign-in: code send failed");
    }
  })();
}

export type SignInVerifyOutcome = { verified: true } | { verified: false };
const REFUSED: SignInVerifyOutcome = { verified: false };

/**
 * Redeem a sign-in code. Wrong, expired, consumed, locked, never-issued and
 * lost-race all collapse into one refusal; success consumes the code exactly
 * once via compare-and-set.
 */
export async function verifySignInCode(opts: {
  channel: SignInChannel;
  identifier: string;
  code: string;
  now: Date;
}): Promise<SignInVerifyOutcome> {
  const { channel, identifier, code, now } = opts;
  if (!codeShapeOk(code)) return REFUSED;
  const identifierHash = identifierDigest(channel, identifier);

  return runAsOwner(async (tx) => {
    const row = await tx.customerSignInCode.findUnique({
      where: { channel_identifierHash: { channel, identifierHash } },
      select: { id: true, codeHash: true, expiresAt: true, consumedAt: true },
    });
    if (!row || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) return REFUSED;

    // Claim an attempt atomically, guarded by the cap.
    const claimed = await tx.customerSignInCode.updateMany({
      where: { id: row.id, consumedAt: null, attemptCount: { lt: MAX_ATTEMPTS } },
      data: { attemptCount: { increment: 1 } },
    });
    if (claimed.count === 0) return REFUSED;

    if (!digestsMatch(row.codeHash, codeDigest(channel, identifier, code))) return REFUSED;

    // Consume exactly once; two racing correct codes get one winner.
    const consumed = await tx.customerSignInCode.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (consumed.count === 0) return REFUSED;
    return { verified: true };
  });
}
