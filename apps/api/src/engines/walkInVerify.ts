import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { logger } from "../logger.js";

/**
 * Walk-In Mode kiosk phone verification: the six-digit OTP lifecycle.
 *
 * THE CONTRACT. A challenge proves exactly one thing - "the person at THIS
 * shop's kiosk holds THIS phone right now" - and is spent proving it once.
 * Everything here is built so the answer to an attacker is one uniform
 * refusal:
 *
 *   - the code exists only in the SMS; the row stores a SCOPE-BOUND hash
 *     (shopId + phone + purpose folded into the digest), so a code minted
 *     anywhere proves nothing anywhere else;
 *   - one row per (shop, phone), updated in place - "one active challenge"
 *     is the table's unique index, not a convention;
 *   - attempts are claimed by a guarded increment and consumption is a CAS,
 *     so two concurrent correct submissions produce EXACTLY one winner and
 *     over-attempt hammering hits a hard floor;
 *   - wrong, expired, replayed, over-attempt, and never-issued all collapse
 *     into the same `verified: false` - no branch tells the caller which;
 *   - a successful verify mints a single-use CHECK-IN PROOF (hash only) so
 *     the later check-in POST can prove the phone without carrying the code.
 *
 * `now` is a parameter everywhere (the clock-tick rule).
 */

export const CODE_TTL_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_MS = 60 * 1000;
/** Sends allowed per phone per rolling window (tracked on the row). */
export const MAX_SENDS_PER_WINDOW = 5;
export const SEND_WINDOW_MS = 60 * 60 * 1000;
export const PROOF_TTL_MS = 10 * 60 * 1000;
/** Challenges one shop may mint across all phones in CHALLENGE_WINDOW_MS -
 * the per-shop ceiling under the outer per-IP limiter. */
export const SHOP_CHALLENGE_CAP = 30;
export const CHALLENGE_WINDOW_MS = 10 * 60 * 1000;
/** Rows whose challenge expired this long ago are swept on the next
 * challenge - the explicit cleanup that replaces a cron. */
const CLEANUP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function sha256Hex(v: string): string {
  return createHash("sha256").update(v, "utf8").digest("hex");
}

/** The scope binding: shop + phone + purpose are part of the digest. */
export function hashCode(shopId: string, phone: string, code: string): string {
  return sha256Hex(`${shopId}:${phone}:walk_in_check_in:${code}`);
}

/** Uniform six digits from the CSPRNG (never Math.random). */
export function mintCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export type ChallengeOutcome =
  /** A code was minted; `code` goes into the SMS and nowhere else. */
  | { send: true; code: string }
  /** Cooldown / caps / ceiling: answer the SAME ok, send nothing. The
   * `reason` is a machine code for the log line only. */
  | { send: false; reason: "cooldown" | "phone_cap" | "shop_cap" };

/**
 * Mint (or refresh) the one challenge for this shop+phone. The caller has
 * already normalized the phone and checked the shop's gates.
 */
export async function issueChallenge(opts: {
  shopId: string;
  phone: string;
  now: Date;
}): Promise<ChallengeOutcome> {
  const { shopId, phone, now } = opts;

  // Explicit cleanup instead of a cron: sweep this shop's long-dead rows on
  // the way in. Bounded, indexed, and can never touch a live challenge.
  await prisma.walkInPhoneCode.deleteMany({
    where: { shopId, expiresAt: { lt: new Date(now.getTime() - CLEANUP_AFTER_MS) } },
  });

  // Per-shop ceiling across all phones - a kiosk minting 30 challenges in
  // ten minutes is not a queue of customers, it is a script.
  const recent = await prisma.walkInPhoneCode.count({
    where: { shopId, lastSentAt: { gt: new Date(now.getTime() - CHALLENGE_WINDOW_MS) } },
  });
  if (recent >= SHOP_CHALLENGE_CAP) return { send: false, reason: "shop_cap" };

  const existing = await prisma.walkInPhoneCode.findUnique({
    where: { shopId_phone: { shopId, phone } },
  });
  if (existing) {
    if (now.getTime() - existing.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
      return { send: false, reason: "cooldown" };
    }
    const inWindow =
      now.getTime() - existing.lastSentAt.getTime() < SEND_WINDOW_MS;
    if (inWindow && existing.sendCount >= MAX_SENDS_PER_WINDOW) {
      return { send: false, reason: "phone_cap" };
    }
    const code = mintCode();
    await prisma.walkInPhoneCode.update({
      where: { id: existing.id },
      data: {
        codeHash: hashCode(shopId, phone, code),
        attemptCount: 0,
        expiresAt: new Date(now.getTime() + CODE_TTL_MS),
        consumedAt: null,
        proofHash: null,
        proofExpiresAt: null,
        proofConsumedAt: null,
        lastSentAt: now,
        sendCount: inWindow ? existing.sendCount + 1 : 1,
      },
    });
    return { send: true, code };
  }

  const code = mintCode();
  await prisma.walkInPhoneCode.create({
    data: {
      shopId,
      phone,
      codeHash: hashCode(shopId, phone, code),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      lastSentAt: now,
    },
  });
  return { send: true, code };
}

export type VerifyOutcome =
  | { verified: true; proof: string }
  | { verified: false };

const REFUSED: VerifyOutcome = { verified: false };

/**
 * Redeem a code. Every failure - unknown phone, expired, consumed, locked,
 * wrong code, lost race - is the SAME refusal.
 */
export async function verifyChallenge(opts: {
  shopId: string;
  phone: string;
  code: string;
  now: Date;
}): Promise<VerifyOutcome> {
  const { shopId, phone, code, now } = opts;
  // Shape first: a non-six-digit string costs a regex, not a query.
  if (!/^\d{6}$/.test(code)) return REFUSED;

  const row = await prisma.walkInPhoneCode.findUnique({
    where: { shopId_phone: { shopId, phone } },
    select: {
      id: true,
      codeHash: true,
      expiresAt: true,
      consumedAt: true,
    },
  });
  if (!row || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) {
    return REFUSED;
  }

  // Claim an attempt ATOMICALLY, guarded by the cap - concurrent hammering
  // cannot mint extra guesses, and a locked challenge stays locked.
  const claimed = await prisma.walkInPhoneCode.updateMany({
    where: { id: row.id, consumedAt: null, attemptCount: { lt: MAX_ATTEMPTS } },
    data: { attemptCount: { increment: 1 } },
  });
  if (claimed.count === 0) return REFUSED;

  // Constant-time compare of equal-length digests. (The hash lookup pattern
  // makes timing moot for the DB read; this covers the comparison itself.)
  const expected = Buffer.from(row.codeHash, "hex");
  const actual = Buffer.from(hashCode(shopId, phone, code), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return REFUSED;
  }

  // Consume EXACTLY once. Two racing correct codes both reach here; this CAS
  // picks the single winner, and the loser gets the uniform refusal.
  const proof = randomToken(32);
  const consumed = await prisma.walkInPhoneCode.updateMany({
    where: { id: row.id, consumedAt: null },
    data: {
      consumedAt: now,
      proofHash: sha256Hex(proof),
      proofExpiresAt: new Date(now.getTime() + PROOF_TTL_MS),
      proofConsumedAt: null,
    },
  });
  if (consumed.count === 0) return REFUSED;
  return { verified: true, proof };
}

/**
 * Spend the check-in proof. Single-use via CAS; bound to the exact shop AND
 * phone the code verified, so a proof cannot be replayed elsewhere or
 * attached to a different number.
 */
export async function consumeCheckInProof(opts: {
  shopId: string;
  phone: string;
  proof: string;
  now: Date;
}): Promise<boolean> {
  const { shopId, phone, proof, now } = opts;
  if (proof.length < 20 || proof.length > 512) return false;
  const spent = await prisma.walkInPhoneCode.updateMany({
    where: {
      shopId,
      phone,
      proofHash: sha256Hex(proof),
      proofConsumedAt: null,
      proofExpiresAt: { gt: now },
    },
    data: { proofConsumedAt: now },
  });
  if (spent.count === 0) {
    // Key names only, never values - same discipline as the audit metadata.
    logger.info({ shopId }, "walk-in verify: proof refused");
    return false;
  }
  return true;
}
