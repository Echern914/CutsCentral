import { createHmac } from "node:crypto";
import { Prisma, prisma, runAsOwner } from "@chairback/db";
import { getMessageProvider } from "../messaging/twilio.js";
import { apiEnv, decrypt, encrypt, randomToken } from "@chairback/config";
import { logger } from "../logger.js";
import {
  CLEANUP_AFTER_MS,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  PROOF_TTL_MS,
  RESEND_COOLDOWN_MS,
  codeShapeOk,
  digestsMatch,
  hashOtp,
  mintCode,
  proofShapeOk,
  sha256Hex,
} from "../engines/otpPolicy.js";
import {
  billableSegments,
  bumpRecoverySmsMetric,
  takeRecoverySmsBudget,
} from "./recoverySmsBudget.js";

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

/**
 * 🔴 What the audit row stores INSTEAD of the SMS body. The real body carries
 * a live OTP, and an audit/history field is no place for a credential - the
 * provider gets the body in memory and nothing else ever does. Same rule as
 * the manager resend's "Rewards access link".
 */
export const RECOVERY_NUDGE_BODY = "Rewards verification message";

/** Challenges one IP may mint across ALL phones per window - the platform
 * analogue of the kiosk's per-shop ceiling. A caller rotating phone numbers
 * piles rows onto one ipHash and stops here; the per-phone sendCount cap is
 * the independent brake for a distributed caller targeting one number. */
export const IP_CHALLENGE_CAP = 10;
export const IP_CHALLENGE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Per-phone spend, tighter than the kiosk's shared policy on purpose: this is
 * an unauthenticated public door and each send is real money. Three recovery
 * texts per phone per rolling day; the 60s resend cooldown is the shared one.
 */
export const RECOVERY_MAX_SENDS_PER_DAY = 3;
export const RECOVERY_SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  /** `auditClient` = the OLDEST textable Client row, whose existing consent is
   * what authorizes the neutral SMS; it feeds the Nudge audit row and nothing
   * else. Deterministic on purpose - never activity-based. */
  | {
      send: true;
      code: string;
      /** The exact final body the provider must send - built, measured and
       * reserved inside the winning transaction. */
      body: string;
      /** The PENDING audit row committed WITH the win - dispatch updates
       * exactly this reservation. */
      nudgeId: string;
      auditClient: { id: string; shopId: string };
    }
  /** 🔴 INTERNAL ONLY - `reason` (including "ineligible") must never reach a
   * response, a log line, analytics or audit free text. The routes answer the
   * same ok for every reason, and log nothing per-outcome. */
  | {
      send: false;
      reason: "cooldown" | "phone_cap" | "ip_cap" | "ineligible" | "platform_budget";
    };

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
    // 🔴 Serialize per-IP FIRST. The ceiling below is count-then-insert, and
    // without this lock N parallel distinct-phone challenges from one address
    // could all observe count < cap before any of them commits - the classic
    // read-modify race. pg_advisory_xact_lock is the house primitive (the
    // booking guard's), releases at commit/rollback, and holds across
    // replicas because it lives in Postgres, not the process.
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`rec:${ipHash}`}))`,
    );

    // Inline bounded cleanup - the same replace-a-cron pattern as the kiosk.
    // This is THE cleanup; there is no scheduled job to seed or to forget.
    await tx.phoneRecoveryCode.deleteMany({
      where: { expiresAt: { lt: new Date(now.getTime() - CLEANUP_AFTER_MS) } },
    });

    // 🔴 ELIGIBILITY BEFORE ANY SEND OR ROW: a code goes only to a phone with
    // at least one non-archived Client row that is textable under the shop's
    // EXISTING consent rule (optedOut false AND smsConsentAt set). Without
    // this, the route was a public "text any number on our Twilio bill"
    // primitive - the caps bounded it but did not remove it. An ineligible
    // phone gets no SMS, no row, and therefore no spendable anything; the
    // decision is returned as an internal reason the routes never echo, and
    // OLDEST-textable keeps the audit attribution deterministic.
    const candidates = await tx.client.findMany({
      where: { phone, archivedAt: null, optedOut: false, smsConsentAt: { not: null } },
      select: { id: true, shopId: true },
      orderBy: { createdAt: "asc" },
      take: 1,
    });
    const auditClient = candidates[0] ?? null;
    if (!auditClient) return { send: false, reason: "ineligible" };

    // 🔴 The combined rewards-access ledger lock, SECOND after the IP lock -
    // the same key the manager resend takes (its only lock), so the two doors
    // can never interleave their reads of the client's loyalty Nudge trail.
    // Lock order everywhere: rec:<ipHash> then nudge:<clientId>; the manager
    // path takes only the second, so no cycle is possible.
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`nudge:${auditClient.id}`}))`,
    );

    // Platform-wide per-IP ceiling, counted on the table under the lock above
    // so it is atomic - and keyed on a digest, never an address. Only
    // ELIGIBLE challenges reach this count, because only they cost an SMS.
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
      const inWindow =
        now.getTime() - existing.lastSentAt.getTime() < RECOVERY_SEND_WINDOW_MS;
      if (inWindow && existing.sendCount >= RECOVERY_MAX_SENDS_PER_DAY) {
        return { send: false, reason: "phone_cap" };
      }
      const code = mintCode();
      const body = recoverySmsBody(code);
      // 🔴 THE PLATFORM CIRCUIT BREAKER, in BILLABLE SEGMENTS of the exact
      // final body - the last gate before real spend is committed. Reserved
      // here, before dispatch, and never given back: an ambiguous provider
      // outcome may still have cost money.
      if (!(await takeRecoverySmsBudget(tx, now, billableSegments(body)))) {
        return { send: false, reason: "platform_budget" };
      }
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
      // GENUINELY write-ahead: the redacted PENDING audit row commits WITH the
      // win, so a process that dies after responding still left the ledger
      // entry - and an immediate manager resend sees this reservation before
      // it evaluates its own cooldown or daily cap.
      const nudge = await tx.nudge.create({
        data: {
          shopId: auditClient.shopId,
          clientId: auditClient.id,
          channel: "SMS",
          status: "PENDING",
          kind: "loyalty",
          body: RECOVERY_NUDGE_BODY,
        },
        select: { id: true },
      });
      return { send: true, code, body, auditClient, nudgeId: nudge.id };
    }

    const code = mintCode();
    const body = recoverySmsBody(code);
    if (!(await takeRecoverySmsBudget(tx, now, billableSegments(body)))) {
      return { send: false, reason: "platform_budget" };
    }
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
    const nudge = await tx.nudge.create({
      data: {
        shopId: auditClient.shopId,
        clientId: auditClient.id,
        channel: "SMS",
        status: "PENDING",
        kind: "loyalty",
        body: RECOVERY_NUDGE_BODY,
      },
      select: { id: true },
    });
    return { send: true, code, body, auditClient, nudgeId: nudge.id };
  });
}

/**
 * The ONE production recovery SMS, for both entry points. GSM-7 only and one
 * segment by construction - no emoji, no curly punctuation, no Unicode - and
 * it carries the code AND the door, so the ENTIRE legacy journey (tap the
 * link, enter the number, enter THIS code, choose the business) costs exactly
 * one message. Never a shop name, customer name, rewards token, phone or
 * credential; never a code or proof in the URL. Pinned by a GSM-7 segment
 * test - edit with that test open.
 */
export function recoverySmsBody(code: string): string {
  const base = apiEnv().APP_BASE_URL.replace(/\/$/, "");
  return `ChairBack code: ${code}. Open ${base}/my-rewards to choose your business. Expires in 5 minutes. Reply STOP to opt out.`;
}

/**
 * THE one challenge entry - the new recovery route AND the legacy
 * resolve-by-phone both come through here, so there is exactly one
 * eligibility decision, one cooldown, one per-phone daily budget, one IP
 * ceiling, one platform circuit breaker and one purpose binding. A caller
 * alternating between the two endpoints draws on the SAME allowances.
 *
 * The SMS is FIRE-AND-FORGET: the caller's response goes out before any
 * provider work on EVERY path, so "known" and "unknown" cannot be told apart
 * by awaiting Twilio on one branch. Residual limitation, stated rather than
 * papered over: an eligible challenge performs one indexed row write inside
 * the transaction that an ineligible one does not - a sub-millisecond
 * database-side difference, not a provider round-trip. Flattening that too
 * would mean writing junk rows for arbitrary phones, which is the wrong trade.
 *
 * NO RETRY, EVER: one provider call per won challenge. A timeout or ambiguous
 * response already consumed the budget (see issueRecoveryChallenge), and
 * retrying an ambiguous send is how one customer gets three texts.
 *
 * Failure handling is CLASSIFICATION-ONLY: provider errors can embed the
 * destination number, the message body or credential material, so neither the
 * error object nor its message ever reaches a log line, a Nudge row, a metric
 * key or monitoring from this path.
 */
export async function requestRecoveryChallenge(opts: {
  phone: string;
  ip: string;
  now: Date;
}): Promise<void> {
  const { phone, ip, now } = opts;
  const outcome = await issueRecoveryChallenge({ phone, ip, now });
  if (!outcome.send) {
    // Safe aggregate counters only - never for "ineligible", which would turn
    // the metric stream into an existence oracle for whoever can read it.
    if (outcome.reason === "phone_cap") bumpRecoverySmsMetric("sup_phone", now);
    if (outcome.reason === "ip_cap") bumpRecoverySmsMetric("sup_ip", now);
    if (outcome.reason === "platform_budget") bumpRecoverySmsMetric("sup_budget", now);
    return;
  }
  bumpRecoverySmsMetric("attempt", now);
  bumpRecoverySmsMetric("segments", now, billableSegments(outcome.body));

  // ONLY dispatch and the SENT/FAILED update run after commit - the audit row,
  // the allowances and the segment reservation are already durable. A process
  // killed right here leaves a PENDING row and a consumed budget, which is the
  // honest record of "we may have paid for this".
  void (async () => {
    try {
      const result = await getMessageProvider().send({ to: phone, body: outcome.body });
      bumpRecoverySmsMetric("accepted", now);
      await runAsOwner((tx) =>
        tx.nudge.update({
          where: { id: outcome.nudgeId },
          data: { status: "SENT", sentAt: new Date(), messageSid: result.sid },
        }),
      );
    } catch {
      // 🔴 Fixed classification only - the thrown value may carry the phone,
      // the OTP, the SMS body, an Authorization header or a credential.
      bumpRecoverySmsMetric("failed", now);
      logger.warn({ nudgeId: outcome.nudgeId }, "rewards recovery: challenge send failed");
      await runAsOwner((tx) =>
        tx.nudge.update({
          where: { id: outcome.nudgeId },
          data: { status: "FAILED", failedReason: "send_failed" },
        }),
      ).catch(() => {});
    }
  })();
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
