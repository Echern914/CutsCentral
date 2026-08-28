import { createHmac } from "node:crypto";
import { prisma, runAsOwner } from "@chairback/db";
import { apiEnv, decrypt, encrypt, randomToken } from "@chairback/config";
import { logger } from "../logger.js";
import {
  CLEANUP_AFTER_MS,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  MAX_SENDS_PER_WINDOW,
  PROOF_TTL_MS,
  RESEND_COOLDOWN_MS,
  SEND_WINDOW_MS,
  codeShapeOk,
  digestsMatch,
  hashOtp,
  mintCode,
  proofShapeOk,
  sha256Hex,
} from "../engines/otpPolicy.js";

/**
 * Rewards recovery: prove you hold the phone, THEN learn what it unlocks.
 *
 * The order is the whole design. Before verification the platform admits
 * nothing - not whether the number is known, not how many shops know it, not
 * whether rewards exist. After verification the customer (and only the
 * customer: the proof never leaves their device) gets a private chooser of
 * their own shops and picks one; that choice mints exactly one shop-bound
 * rewards credential. "Which shops know this phone" is the QUESTION this flow
 * answers, which is why these rows have no shopId and cannot be tenant data.
 *
 * Storage discipline (see PhoneRecoveryCode in the schema):
 *   - lookups, uniqueness and every ceiling run on an HMAC of the phone - a
 *     10-digit number is enumerable, so a bare sha256 would be reversible;
 *   - the E.164 itself is retained ONLY for the post-verification Client
 *     lookup, encrypted with the same house pattern as the OAuth tokens
 *     (packages/config crypto + TOKEN_ENCRYPTION_KEY), on short-TTL rows the
 *     inline cleanup sweeps - deliberately NOT a new scheme;
 *   - the plaintext code exists only in the SMS.
 *
 * Everything here runs as the OWNER: the table is REVOKE-ALL + forced RLS with
 * zero policies, so the tenant role cannot touch it at all.
 */

export const RECOVERY_PURPOSE = "rewards_recovery" as const;

/** Challenges one IP may mint across ALL phones per window - the platform
 * analogue of the kiosk's per-shop ceiling. A caller rotating phone numbers
 * piles rows onto one ipHash and stops here; the per-phone sendCount cap is
 * the independent brake for a distributed caller targeting one number. */
export const IP_CHALLENGE_CAP = 10;
export const IP_CHALLENGE_WINDOW_MS = 10 * 60 * 1000;

/** The chooser never returns more rows than a human has shops. */
export const MAX_CHOOSER_SHOPS = 12;

/** HMAC key for phone/ip digests, derived from the existing secret rather than
 * minting a new env var (the fail-closed lesson). Purpose-tagged so these
 * digests can never collide with anything else derived from the same key. */
function hmacKey(): string {
  return `${apiEnv().TOKEN_ENCRYPTION_KEY}:phone_recovery_hmac_v1`;
}

export function phoneDigest(e164: string): string {
  return createHmac("sha256", hmacKey()).update(e164, "utf8").digest("hex");
}

export function ipDigest(ip: string): string {
  return createHmac("sha256", hmacKey()).update(`ip:${ip}`, "utf8").digest("hex");
}

export type RecoveryChallengeOutcome =
  | { send: true; code: string }
  | { send: false; reason: "cooldown" | "phone_cap" | "ip_cap" };

/**
 * Mint (or refresh) the one recovery challenge for this phone. The caller has
 * already normalized the phone; the route answers the same `ok` either way.
 */
export async function issueRecoveryChallenge(opts: {
  phone: string;
  ip: string;
  now: Date;
}): Promise<RecoveryChallengeOutcome> {
  const { phone, ip, now } = opts;
  const phoneHash = phoneDigest(phone);
  const ipHash = ipDigest(ip);

  return runAsOwner(async (tx) => {
    // Inline bounded cleanup - the same replace-a-cron pattern as the kiosk.
    // This is THE cleanup; there is no scheduled job to seed or to forget.
    await tx.phoneRecoveryCode.deleteMany({
      where: { expiresAt: { lt: new Date(now.getTime() - CLEANUP_AFTER_MS) } },
    });

    // Platform-wide per-IP ceiling, counted on the table itself so it holds
    // across replicas and restarts - and keyed on a digest, never an address.
    const fromThisIp = await tx.phoneRecoveryCode.count({
      where: {
        ipHash,
        lastSentAt: { gt: new Date(now.getTime() - IP_CHALLENGE_WINDOW_MS) },
      },
    });
    if (fromThisIp >= IP_CHALLENGE_CAP) return { send: false, reason: "ip_cap" };

    const existing = await tx.phoneRecoveryCode.findUnique({
      where: { purpose_phoneHash: { purpose: RECOVERY_PURPOSE, phoneHash } },
    });
    if (existing) {
      if (now.getTime() - existing.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
        return { send: false, reason: "cooldown" };
      }
      const inWindow = now.getTime() - existing.lastSentAt.getTime() < SEND_WINDOW_MS;
      if (inWindow && existing.sendCount >= MAX_SENDS_PER_WINDOW) {
        return { send: false, reason: "phone_cap" };
      }
      const code = mintCode();
      await tx.phoneRecoveryCode.update({
        where: { id: existing.id },
        data: {
          codeHash: hashOtp(RECOVERY_PURPOSE, phone, RECOVERY_PURPOSE, code),
          phoneEnc: encrypt(phone, apiEnv().TOKEN_ENCRYPTION_KEY),
          ipHash,
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
    // A raced double-create collapses on @@unique([purpose, phoneHash]): the
    // loser's P2002 is caught and answered as a cooldown, which is literally
    // true - a challenge for this phone was just created.
    try {
      await tx.phoneRecoveryCode.create({
        data: {
          purpose: RECOVERY_PURPOSE,
          phoneHash,
          phoneEnc: encrypt(phone, apiEnv().TOKEN_ENCRYPTION_KEY),
          ipHash,
          codeHash: hashOtp(RECOVERY_PURPOSE, phone, RECOVERY_PURPOSE, code),
          expiresAt: new Date(now.getTime() + CODE_TTL_MS),
          lastSentAt: now,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        return { send: false, reason: "cooldown" };
      }
      throw err;
    }
    return { send: true, code };
  });
}

export type RecoveryVerifyOutcome =
  | { verified: true; proof: string }
  | { verified: false };

const REFUSED: RecoveryVerifyOutcome = { verified: false };

/**
 * Redeem a recovery code. Wrong, expired, consumed, locked, never-issued and
 * lost-race all collapse into one refusal; success mints the bounded chooser
 * session (proof), consuming the code exactly once via CAS.
 */
export async function verifyRecoveryChallenge(opts: {
  phone: string;
  code: string;
  now: Date;
}): Promise<RecoveryVerifyOutcome> {
  const { phone, code, now } = opts;
  if (!codeShapeOk(code)) return REFUSED;
  const phoneHash = phoneDigest(phone);

  return runAsOwner(async (tx) => {
    const row = await tx.phoneRecoveryCode.findUnique({
      where: { purpose_phoneHash: { purpose: RECOVERY_PURPOSE, phoneHash } },
      select: { id: true, codeHash: true, expiresAt: true, consumedAt: true },
    });
    if (!row || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) {
      return REFUSED;
    }

    // Claim an attempt atomically, guarded by the cap.
    const claimed = await tx.phoneRecoveryCode.updateMany({
      where: { id: row.id, consumedAt: null, attemptCount: { lt: MAX_ATTEMPTS } },
      data: { attemptCount: { increment: 1 } },
    });
    if (claimed.count === 0) return REFUSED;

    if (!digestsMatch(row.codeHash, hashOtp(RECOVERY_PURPOSE, phone, RECOVERY_PURPOSE, code))) {
      return REFUSED;
    }

    // Consume exactly once; two racing correct codes get one winner.
    const proof = randomToken(32);
    const consumed = await tx.phoneRecoveryCode.updateMany({
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
  });
}

export interface ChooserShop {
  /** Opaque, proof-bound. NOT a shop id, NOT a client id - recomputable by the
   * server, meaningless to everyone else. */
  selectionId: string;
  name: string;
  logoUrl: string | null;
  industry: string;
  city: string | null;
  region: string | null;
}

/** The selection id: bound to THIS proof, derived rather than stored, and
 * useless the moment the proof dies. */
function selectionIdFor(proofHashHex: string, clientId: string): string {
  return createHmac("sha256", hmacKey())
    .update(`select:${proofHashHex}:${clientId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/**
 * 🔴 THE ONE INTENTIONAL CROSS-SHOP READ IN THE PRODUCT - a proof-gated
 * platform lookup, not an accidental RLS bypass.
 *
 * Every other read in the product is pinned to one shop; this one exists
 * because "which of MY shops can I open" is a question only the platform can
 * answer, and it is safe to answer here because the caller has just proven
 * possession of the phone the answer is about. The boundary:
 *
 *   - runs only behind a live, unconsumed recovery proof;
 *   - matches ONLY the verified phone - no shop ids, filters or search terms
 *     are accepted from the caller;
 *   - fixed minimal select: public name, logo, business type, city/state.
 *     Never balances, visits, appointments, phone numbers, internal ids or
 *     configuration - the select below is the whole contract;
 *   - one row per shop (duplicate client rows collapse), bounded count,
 *     deterministic order.
 *
 * ELIGIBILITY IS ACCESS, NOT TEXTING - deliberately. The existing consent
 * rule (optedOut/smsConsentAt) governs SENDING a text; nothing is sent here.
 * The existing rule for rewards ACCESS is the magicToken link, which works for
 * a STOP'd customer - it has to, because the rewards page is where START
 * lives. So the chooser shows every shop holding a non-archived client row
 * for the verified phone, and an archived row is simply absent - no reason,
 * no count, nothing to infer from.
 */
export async function listRecoveryShops(opts: {
  proof: string;
  now: Date;
}): Promise<ChooserShop[] | null> {
  const { proof, now } = opts;
  if (!proofShapeOk(proof)) return null;
  const proofHash = sha256Hex(proof);

  return runAsOwner(async (tx) => {
    const row = await tx.phoneRecoveryCode.findUnique({
      where: { proofHash },
      select: { phoneEnc: true, proofExpiresAt: true, proofConsumedAt: true },
    });
    if (!row || row.proofConsumedAt || !row.proofExpiresAt || row.proofExpiresAt.getTime() <= now.getTime()) {
      return null;
    }
    const phone = decrypt(row.phoneEnc, apiEnv().TOKEN_ENCRYPTION_KEY);

    const clients = await tx.client.findMany({
      where: { phone, archivedAt: null },
      // Fixed minimal select - THE contract. Adding a field here is a privacy
      // decision, not a convenience.
      select: {
        id: true,
        shopId: true,
        shop: {
          select: {
            name: true,
            logoUrl: true,
            industry: true,
            addressCity: true,
            addressRegion: true,
          },
        },
      },
      // Deterministic long before the dedupe: stable ids, not activity.
      orderBy: { id: "asc" },
      take: MAX_CHOOSER_SHOPS * 4,
    });

    // One entry per shop. Duplicate client rows for one phone at one shop
    // collapse onto the FIRST by id order - deterministic, and deliberately
    // not "most recently active", which is the exact selection rule this flow
    // exists to remove.
    const byShop = new Map<string, (typeof clients)[number]>();
    for (const c of clients) {
      if (!byShop.has(c.shopId)) byShop.set(c.shopId, c);
    }

    return [...byShop.values()]
      .map((c) => ({
        selectionId: selectionIdFor(proofHash, c.id),
        name: c.shop.name,
        logoUrl: c.shop.logoUrl,
        industry: c.shop.industry,
        city: c.shop.addressCity,
        region: c.shop.addressRegion,
      }))
      .sort(
        (a, b) => a.name.localeCompare(b.name) || a.selectionId.localeCompare(b.selectionId),
      )
      .slice(0, MAX_CHOOSER_SHOPS);
  });
}

export type RecoverySelectOutcome =
  | { ok: true; rewardsUrl: string }
  | { ok: false };

/**
 * Spend the proof on ONE shop. The proof is consumed by CAS before the
 * credential is produced, so two racing selections - same shop or different -
 * mint exactly one, and a replay after success is the uniform refusal.
 *
 * A selectionId that matches nothing does NOT consume the proof: a mistyped
 * tap must not burn the session, and the caller holding a valid proof could
 * list the chooser anyway - there is nothing to probe.
 */
export async function selectRecoveryShop(opts: {
  proof: string;
  selectionId: string;
  now: Date;
}): Promise<RecoverySelectOutcome> {
  const { proof, selectionId, now } = opts;
  if (!proofShapeOk(proof)) return { ok: false };
  if (!/^[a-f0-9]{32}$/.test(selectionId)) return { ok: false };
  const proofHash = sha256Hex(proof);

  return runAsOwner(async (tx) => {
    const row = await tx.phoneRecoveryCode.findUnique({
      where: { proofHash },
      select: { id: true, phoneEnc: true, proofExpiresAt: true, proofConsumedAt: true },
    });
    if (!row || row.proofConsumedAt || !row.proofExpiresAt || row.proofExpiresAt.getTime() <= now.getTime()) {
      return { ok: false };
    }
    const phone = decrypt(row.phoneEnc, apiEnv().TOKEN_ENCRYPTION_KEY);

    // Resolve the selection against the same eligibility the chooser used.
    const clients = await tx.client.findMany({
      where: { phone, archivedAt: null },
      select: { id: true, shopId: true, magicToken: true },
      orderBy: { id: "asc" },
      take: MAX_CHOOSER_SHOPS * 4,
    });
    const byShop = new Map<string, (typeof clients)[number]>();
    for (const c of clients) {
      if (!byShop.has(c.shopId)) byShop.set(c.shopId, c);
    }
    const chosen = [...byShop.values()].find(
      (c) => selectionIdFor(proofHash, c.id) === selectionId,
    );
    if (!chosen) return { ok: false };

    // Exactly one winner - the CAS is the arbiter, and it happens BEFORE the
    // credential leaves this function.
    const spent = await tx.phoneRecoveryCode.updateMany({
      where: { id: row.id, proofConsumedAt: null },
      data: { proofConsumedAt: now },
    });
    if (spent.count === 0) return { ok: false };

    // Ids only - the phone never reaches a log line.
    logger.info(
      { shopId: chosen.shopId, clientId: chosen.id },
      "rewards recovery: shop selected",
    );
    const base = apiEnv().APP_BASE_URL.replace(/\/$/, "");
    return { ok: true, rewardsUrl: `${base}/r/${chosen.magicToken}/rewards` };
  });
}

/**
 * Does ANY shop know this phone? Used only to decide whether the legacy
 * neutral SMS is worth a Twilio charge - the answer never reaches a response
 * body, and the route replies identically either way.
 */
export async function phoneHasAnyClient(phone: string): Promise<{
  any: boolean;
  /** The row whose consent authorized the send, for the Nudge audit trail:
   * the OLDEST textable match - deterministic and deliberately NOT
   * activity-based, which is the selection rule this flow removed. */
  auditClient: { id: string; shopId: string } | null;
}> {
  return runAsOwner(async (tx) => {
    const rows = await tx.client.findMany({
      where: { phone, archivedAt: null },
      select: { id: true, shopId: true, createdAt: true, optedOut: true, smsConsentAt: true },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    const textable = rows.find((r) => !r.optedOut && r.smsConsentAt !== null);
    return { any: rows.length > 0, auditClient: textable ? { id: textable.id, shopId: textable.shopId } : null };
  });
}
