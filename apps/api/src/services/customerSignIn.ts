import { createHmac } from "node:crypto";
import { Prisma, runAsOwner } from "@chairback/db";
import { apiEnv, isLikelyEmail, randomToken } from "@chairback/config";
import { toE164 } from "../acuity/clientKey.js";
import { kickSignInDelivery, sealSignIn } from "../engines/customerSignInOutbox.js";
import { signInSmsBody } from "./customerSignInMessage.js";
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

/** The message bodies live in their own module (the delivery worker renders
 *  them too); re-exported here because this is where callers look for them. */
export { signInEmail, signInSmsBody } from "./customerSignInMessage.js";

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
  | { send: true; code: string; deliveryId: string }
  /** 🔴 INTERNAL ONLY - never echoed to a response, a log line or a metric. */
  | { send: false; reason: "cooldown" | "identifier_cap" | "ip_cap" | "platform_budget" };

/**
 * Mint (or refresh) the one sign-in challenge for this identifier, AND the
 * promise to deliver it, in ONE transaction.
 *
 * 🔴 THE CHALLENGE AND THE DELIVERY COMMIT TOGETHER OR NOT AT ALL. Anything
 * else leaves a customer holding a code nobody was asked to send, behind a
 * cooldown telling them to wait. Re-issuing SUPERSEDES the previous delivery
 * in the same transaction, so a retry can never leave two codes that both
 * work: there is one live challenge per identifier, and the code that is live
 * is whichever one this row now holds.
 */
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

    const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
    const fresh = {
      codeHash: codeDigest(channel, identifier, code),
      ipHash,
      attemptCount: 0,
      expiresAt,
      consumedAt: null,
      lastSentAt: now,
    };
    let codeId: string;
    if (existing) {
      await tx.customerSignInCode.update({
        where: { id: existing.id },
        data: { ...fresh, sendCount: inWindow ? existing.sendCount + 1 : 1 },
      });
      codeId = existing.id;
      // The code this row held a moment ago is gone; so is any promise to
      // deliver it. Wiping `sealed` is what makes the CHECK that nothing
      // terminal holds a code true, and stops a worker mid-claim sending a
      // code that no longer verifies.
      await tx.customerSignInDelivery.updateMany({
        where: { codeId, status: "pending" },
        data: { status: "superseded", sealed: null, claimedAt: null, claimToken: null },
      });
    } else {
      try {
        const made = await tx.customerSignInCode.create({
          data: { channel, identifierHash, ...fresh },
          select: { id: true },
        });
        codeId = made.id;
      } catch (err) {
        // A raced double-create collapses on the unique index: a cooldown.
        if ((err as { code?: string }).code === "P2002") return { send: false, reason: "cooldown" };
        throw err;
      }
    }

    const delivery = await tx.customerSignInDelivery.create({
      data: {
        codeId,
        channel,
        // The ONLY place the code and the destination exist at rest, sealed
        // under a key derived for this purpose, wiped when the row settles.
        sealed: sealSignIn({ to: identifier, code }),
        status: "pending",
        nextAttemptAt: now,
        expiresAt,
        idempotencyKey: `customer-sign-in:${randomToken(12)}`,
      },
      select: { id: true },
    });
    return { send: true, code, deliveryId: delivery.id };
  });
}

/**
 * THE one entry the route calls. Answers nothing about the identifier: every
 * path - known, unknown, capped, budget-refused - resolves the same way, and
 * nothing waits on a provider, so no send can be timed.
 *
 * The delivery is already durable when this returns (issueSignInCode
 * committed it). The kick below only makes it FAST: it takes the ordinary
 * claim, and if this process dies mid-flight the scheduled worker picks the
 * row up once that claim ages out.
 */
export async function requestSignInCode(opts: {
  channel: SignInChannel;
  identifier: string;
  ip: string;
  now: Date;
}): Promise<void> {
  const outcome = await issueSignInCode(opts);
  if (!outcome.send) return;
  void kickSignInDelivery(outcome.deliveryId, opts.now);
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
