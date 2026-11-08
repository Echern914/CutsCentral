import { createHmac } from "node:crypto";
import { Prisma, runAsOwner } from "@chairback/db";
import { apiEnv, randomToken } from "@chairback/config";
import { logger } from "../logger.js";
import { emailDispatchMode, sendEmail } from "../messaging/email.js";
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
import { positiveCapFromEnv, takeWindowedBudget } from "./recoverySmsBudget.js";
import { MAX_CONTACT_FANOUT } from "./customerIdentity.js";
import { normalizeEmail } from "./customerSignIn.js";
import { openToken, sealToken } from "./tokenKey.js";

/**
 * Rewards recovery: type your number, prove you hold the email your shop has
 * with it, THEN learn what that unlocks.
 *
 * The order is the whole design. Before verification the platform admits
 * nothing - not whether the number is known, not how many shops know it, not
 * whether rewards exist. After verification the customer (and only the
 * customer: the proof never leaves their device) gets a private chooser of
 * their own shops and picks one; that choice mints exactly one shop-bound
 * rewards credential. "Which shops know this person" is the QUESTION this flow
 * answers, which is why these rows have no shopId and cannot be tenant data.
 *
 * 🔴 THE NUMBER CHOOSES, THE EMAIL PROVES. A phone on a record proves nothing
 * here, because the code no longer goes to the phone: anyone can book with a
 * stranger's number and their own email. So a code unlocks ONLY the records
 * carrying BOTH that number AND the address the code was sent to. A proof from
 * one address must never open a record holding a different one - that would
 * hand a stranger's shops and rewards to whoever typed their number on a
 * booking form. Each address gets its own code and its own row for that reason.
 *
 * The pair is also what makes email usable at all: an imported book shares one
 * email across several records far more often than a phone, so email alone
 * cannot say which record is yours. The number narrows it to one.
 *
 * Why email, not text: this door has to work while texting is off, and a code
 * the customer asked for by email costs next to nothing. The phone-shaped names
 * (PhoneRecoveryCode, phoneHash, phoneEnc) are the table's; those columns now
 * hold the number-and-address pair, kept in the same protected form.
 *
 * Storage discipline (see PhoneRecoveryCode in the schema):
 *   - lookups, uniqueness and every ceiling run on an HMAC - a 10-digit number
 *     is enumerable, so a bare sha256 would be reversible;
 *   - the pair itself is retained ONLY for the post-verification Client lookup,
 *     encrypted with the same house pattern as the OAuth tokens (packages/config
 *     crypto + TOKEN_ENCRYPTION_KEY), on short-TTL rows the inline cleanup
 *     sweeps - deliberately NOT a new scheme;
 *   - the plaintext code exists only in the email.
 *
 * Everything here runs as the OWNER: the table is REVOKE-ALL + forced RLS with
 * zero policies, so the tenant role cannot touch it at all.
 */

export const RECOVERY_PURPOSE = "rewards_recovery" as const;

/** Challenges one IP may mint across ALL phones per window - the platform
 * analogue of the kiosk's per-shop ceiling. A caller rotating phone numbers
 * piles rows onto one ipHash and stops here; the per-address sendCount cap is
 * the independent brake for a distributed caller targeting one person. */
export const IP_CHALLENGE_CAP = 10;
export const IP_CHALLENGE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Per-address sends. This is an unauthenticated public door, and each email is
 * reputation rather than money: the same number My ChairBack's email sign-in
 * allows. The 60s resend cooldown is the shared one.
 */
export const RECOVERY_MAX_SENDS_PER_DAY = 5;
export const RECOVERY_SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Different shops can hold different emails for one number. Each gets a code,
 * up to this many, oldest record first so a later booking cannot push out the
 * address a customer has had on file for years.
 */
export const MAX_ADDRESSES_PER_PHONE = 3;

/** The chooser never returns more rows than a human has shops. */
export const MAX_CHOOSER_SHOPS = 12;

export const RECOVERY_EMAIL_HOURLY_CAP_DEFAULT = 300;
export const RECOVERY_EMAIL_DAILY_CAP_DEFAULT = 2000;

/** Its own ledger: a flood of recovery codes can never starve sign-in's. */
function recoveryEmailBudget() {
  return {
    keyPrefix: "recEmail:budget",
    hourlyCap: positiveCapFromEnv("RECOVERY_EMAIL_HOURLY_CAP", RECOVERY_EMAIL_HOURLY_CAP_DEFAULT),
    dailyCap: positiveCapFromEnv("RECOVERY_EMAIL_DAILY_CAP", RECOVERY_EMAIL_DAILY_CAP_DEFAULT),
    label: { words: "rewards recovery email", code: "recovery_email_budget" },
  };
}

/** HMAC key for digests, derived from the existing secret rather than minting a
 * new env var (the fail-closed lesson). Purpose-tagged so these digests can
 * never collide with anything else derived from the same key. */
function hmacKey(): string {
  return `${apiEnv().TOKEN_ENCRYPTION_KEY}:phone_recovery_hmac_v1`;
}

/** What the code is bound to: this number AND this address. */
function pairIdentity(phone: string, email: string): string {
  return `${phone}|${email}`;
}

/** The row's lookup key for one number-and-address pair. */
export function recoveryPairDigest(phone: string, email: string): string {
  return createHmac("sha256", hmacKey()).update(pairIdentity(phone, email), "utf8").digest("hex");
}

export function ipDigest(ip: string): string {
  return createHmac("sha256", hmacKey()).update(`ip:${ip}`, "utf8").digest("hex");
}

function pairCodeDigest(phone: string, email: string, code: string): string {
  return hashOtp(RECOVERY_PURPOSE, pairIdentity(phone, email), RECOVERY_PURPOSE, code);
}

function sealPair(phone: string, email: string): string {
  return sealToken(JSON.stringify({ phone, email }));
}

/**
 * The pair a proof was earned for. Null for anything else - including a row
 * from before codes went by email, whose sealed value is a bare phone. That
 * row proved a phone and no address, so it opens nothing here.
 */
function openPair(sealed: string): { phone: string; email: string } | null {
  try {
    const parsed = JSON.parse(openToken(sealed)) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { phone?: unknown }).phone === "string" &&
      typeof (parsed as { email?: unknown }).email === "string"
    ) {
      return parsed as { phone: string; email: string };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The addresses a code for this number may go to: each distinct email on the
 * number's active records, oldest record first.
 *
 * An address on more records than one person plausibly has is a placeholder
 * ("noemail@..." or the shop's own inbox), not the customer's, and proves
 * nothing about them. Same line My ChairBack draws (customerIdentity.ts).
 */
async function addressesForPhone(tx: Prisma.TransactionClient, phone: string): Promise<string[]> {
  const rows = await tx.client.findMany({
    where: { phone, archivedAt: null, email: { not: null } },
    select: { email: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const distinct = [...new Set(rows.map((r) => normalizeEmail(r.email)))].filter(
    (e): e is string => e !== null,
  );

  const out: string[] = [];
  const limit = Prisma.raw(String(MAX_CONTACT_FANOUT + 1));
  for (const email of distinct) {
    if (out.length >= MAX_ADDRESSES_PER_PHONE) break;
    const hits = await tx.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT count(*)::int AS "n" FROM (
        SELECT 1 FROM "Client" c
        WHERE lower(btrim(c."email")) = ${email} AND c."archivedAt" IS NULL
        LIMIT ${limit}
      ) AS capped`);
    if ((hits[0]?.n ?? 0) <= MAX_CONTACT_FANOUT) out.push(email);
  }
  return out;
}

/** One code to deliver. In memory only; nothing here is ever stored or logged. */
export interface RecoverySend {
  to: string;
  code: string;
}

type RefusalReason = "cooldown" | "address_cap" | "ip_cap" | "ineligible" | "platform_budget";

export type RecoveryChallengeOutcome =
  | { send: true; sends: RecoverySend[] }
  /** 🔴 INTERNAL ONLY - `reason` (including "ineligible") must never reach a
   * response, a log line, analytics or audit free text. The routes answer the
   * same ok for every reason, and log nothing per-outcome. */
  | { send: false; reason: RefusalReason };

/**
 * Mint (or refresh) the one challenge for one number-and-address pair. Returns
 * the code to send, or why not. Refusals never throw or abort the transaction,
 * because the next address still gets its turn.
 */
async function issueForAddress(
  tx: Prisma.TransactionClient,
  opts: { phone: string; email: string; ipHash: string; now: Date },
): Promise<{ code: string } | { reason: RefusalReason }> {
  const { phone, email, ipHash, now } = opts;
  const phoneHash = recoveryPairDigest(phone, email);
  // 🔴 Serialize per pair: the cooldown and the daily cap below are
  // read-then-write, and the IP lock does nothing for two callers on different
  // IPs. Without this, a burst from several addresses could all read "past the
  // cooldown" and mail several codes, each overwriting the last. Lock order
  // everywhere: rec:<ipHash>, then recPair:<digest> in address order.
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`recPair:${phoneHash}`}))`,
  );
  const existing = await tx.phoneRecoveryCode.findUnique({
    where: { purpose_phoneHash: { purpose: RECOVERY_PURPOSE, phoneHash } },
  });
  const inWindow =
    existing !== null && now.getTime() - existing.lastSentAt.getTime() < RECOVERY_SEND_WINDOW_MS;
  if (existing) {
    if (now.getTime() - existing.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
      return { reason: "cooldown" };
    }
    if (inWindow && existing.sendCount >= RECOVERY_MAX_SENDS_PER_DAY) {
      return { reason: "address_cap" };
    }
  }

  const code = mintCode();
  // 🔴 THE PLATFORM BREAKER, the last gate before a send is committed. Reserved
  // here and never given back: an ambiguous provider outcome may still have
  // sent.
  if (!(await takeWindowedBudget(tx, now, 1, recoveryEmailBudget()))) {
    return { reason: "platform_budget" };
  }

  const fresh = {
    codeHash: pairCodeDigest(phone, email, code),
    phoneEnc: sealPair(phone, email),
    ipHash,
    attemptCount: 0,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    consumedAt: null,
    proofHash: null,
    proofExpiresAt: null,
    proofConsumedAt: null,
    lastSentAt: now,
  };
  if (existing) {
    await tx.phoneRecoveryCode.update({
      where: { id: existing.id },
      data: { ...fresh, sendCount: inWindow ? existing.sendCount + 1 : 1 },
    });
    return { code };
  }
  // The lock above means nothing can have created this row since the read, and
  // @@unique([purpose, phoneHash]) is the database's own backstop if it ever did.
  await tx.phoneRecoveryCode.create({
    data: { purpose: RECOVERY_PURPOSE, phoneHash, ...fresh },
  });
  return { code };
}

/**
 * Mint the challenges for this number, one per address on file. The caller has
 * already normalized the phone; the route answers the same `ok` either way.
 */
export async function issueRecoveryChallenge(opts: {
  phone: string;
  ip: string;
  now: Date;
}): Promise<RecoveryChallengeOutcome> {
  const { phone, ip, now } = opts;
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

    // 🔴 ELIGIBILITY BEFORE ANY SEND OR ROW: a number with no email on file gets
    // no email, no row, and therefore no spendable anything. An SMS STOP does
    // not matter here: it governs texts, and the rewards page is where START
    // lives. The decision stays an internal reason the routes never echo.
    const addresses = await addressesForPhone(tx, phone);
    if (addresses.length === 0) return { send: false, reason: "ineligible" };

    // Platform-wide per-IP ceiling, counted on the table under the lock above
    // so it is atomic - and keyed on a digest, never an address. Only ELIGIBLE
    // challenges reach this count, because only they send anything.
    const fromThisIp = await tx.phoneRecoveryCode.count({
      where: {
        ipHash,
        lastSentAt: { gt: new Date(now.getTime() - IP_CHALLENGE_WINDOW_MS) },
      },
    });
    if (fromThisIp >= IP_CHALLENGE_CAP) return { send: false, reason: "ip_cap" };

    const sends: RecoverySend[] = [];
    let refusal: RefusalReason | null = null;
    for (const email of addresses) {
      const result = await issueForAddress(tx, { phone, email, ipHash, now });
      if ("code" in result) sends.push({ to: email, code: result.code });
      else refusal ??= result.reason;
    }
    return sends.length > 0
      ? { send: true, sends }
      : { send: false, reason: refusal ?? "ineligible" };
  });
}

/**
 * The ONE recovery email, for both entry points. It carries the code AND the
 * door, so the entire legacy journey (open the link, enter the number, enter
 * THIS code, choose the business) costs one message. Never a shop name, customer
 * name, rewards token or phone; never a code or proof in the URL.
 */
export function recoveryEmail(code: string): { subject: string; text: string; html: string } {
  const door = `${apiEnv().APP_BASE_URL.replace(/\/$/, "")}/my-rewards`;
  const subject = `Your ChairBack code: ${code}`;
  const expiry =
    "It expires in 5 minutes. If you didn't ask for it, you can ignore this email - nobody can get in without the code.";
  const text = [
    `Your code to find your rewards is ${code}.`,
    "",
    `Enter it on the page you just came from, or start again at ${door}`,
    "",
    expiry,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#17171b;">
<p style="margin:0 0 16px;font-size:15px;">Your code to find your rewards:</p>
<p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:6px;">${code}</p>
<p style="margin:0 0 16px;font-size:15px;">Enter it on the page you just came from, or start again at <a href="${door}">${door}</a></p>
<p style="margin:0;font-size:13px;color:#5a5a62;">${expiry}</p>
</div>`;
  return { subject, text, html };
}

/**
 * THE one challenge entry - the recovery route AND the legacy resolve-by-phone
 * both come through here, so there is exactly one eligibility decision, one
 * cooldown, one per-address budget, one IP ceiling, one platform circuit breaker
 * and one purpose binding. A caller alternating between the two endpoints draws
 * on the SAME allowances.
 *
 * It does not ask whether texting is on. Nothing here is a text, and this door
 * must stay open while texting is off.
 *
 * The email is FIRE-AND-FORGET: the caller's response goes out before any
 * provider work on EVERY path, so "known" and "unknown" cannot be told apart by
 * awaiting the provider on one branch. Residual limitation, stated rather than
 * papered over: an eligible challenge performs a few indexed row writes inside
 * the transaction that an ineligible one does not - a database-side difference,
 * not a provider round-trip. Flattening that too would mean writing junk rows
 * for arbitrary phones, which is the wrong trade.
 *
 * NO RETRY, EVER: one provider call per won challenge. The customer has a
 * "send a fresh code" button, and a code five minutes old is worth nothing.
 *
 * Failure handling is CLASSIFICATION-ONLY: provider errors can embed the
 * destination, the message body or credential material, so neither the error
 * object nor its message ever reaches a log line or monitoring from this path.
 */
export async function requestRecoveryChallenge(opts: {
  phone: string;
  ip: string;
  now: Date;
}): Promise<void> {
  // Email not configured: nothing could leave, so spend no allowance on it.
  if (emailDispatchMode() === "unconfigured") return;
  const outcome = await issueRecoveryChallenge(opts);
  if (!outcome.send) return;

  for (const send of outcome.sends) {
    void (async () => {
      try {
        const mail = recoveryEmail(send.code);
        await sendEmail({
          to: send.to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          meta: { kind: "rewards_recovery" },
        });
      } catch {
        // 🔴 Fixed classification only - the thrown value may carry the address,
        // the code, the body or a credential.
        logger.warn("rewards recovery: challenge send failed");
      }
    })();
  }
}

export type RecoveryVerifyOutcome =
  | { verified: true; proof: string }
  | { verified: false };

const REFUSED: RecoveryVerifyOutcome = { verified: false };

/**
 * Redeem a recovery code against the number the customer typed. Wrong, expired,
 * consumed, locked, never-issued and lost-race all collapse into one refusal;
 * success mints the bounded chooser session (proof) for the ONE address whose
 * code this was, consuming that code exactly once via CAS.
 *
 * The customer never says which address they read the code from, so each live
 * code for this number is tried, and each one tried spends one of its attempts.
 */
export async function verifyRecoveryChallenge(opts: {
  phone: string;
  code: string;
  now: Date;
}): Promise<RecoveryVerifyOutcome> {
  const { phone, code, now } = opts;
  if (!codeShapeOk(code)) return REFUSED;

  return runAsOwner(async (tx) => {
    for (const email of await addressesForPhone(tx, phone)) {
      const row = await tx.phoneRecoveryCode.findUnique({
        where: {
          purpose_phoneHash: {
            purpose: RECOVERY_PURPOSE,
            phoneHash: recoveryPairDigest(phone, email),
          },
        },
        select: { id: true, codeHash: true, expiresAt: true, consumedAt: true },
      });
      if (!row || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) continue;

      // Claim an attempt atomically, guarded by the cap.
      const claimed = await tx.phoneRecoveryCode.updateMany({
        where: { id: row.id, consumedAt: null, attemptCount: { lt: MAX_ATTEMPTS } },
        data: { attemptCount: { increment: 1 } },
      });
      if (claimed.count === 0) continue;

      if (!digestsMatch(row.codeHash, pairCodeDigest(phone, email, code))) continue;

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
      return consumed.count === 1 ? { verified: true, proof } : REFUSED;
    }
    return REFUSED;
  });
}

export interface ChooserShop {
  /** Opaque, proof-bound. NOT a shop id, NOT a client id - recomputable by the
   * server, meaningless to everyone else. NULL for an ambiguous shop: there
   * is no one record this pair may open there, so nothing to select. */
  selectionId: string | null;
  /**
   * 🔴 More than one person at this shop has this number AND this email (a
   * family sharing both, duplicate profiles). The code proves the visitor reads
   * that inbox - not which of those people they are - so the shop is shown, and
   * the way in is the shop sending them their own link.
   */
  ambiguous: boolean;
  name: string;
  logoUrl: string | null;
  industry: string;
  city: string | null;
  region: string | null;
}

/** A pair's records, one bucket per shop, in the id order they were read. */
function groupByShop<T extends { shopId: string }>(rows: T[]): Map<string, T[]> {
  const byShop = new Map<string, T[]>();
  for (const r of rows) {
    const bucket = byShop.get(r.shopId);
    if (bucket) bucket.push(r);
    else byShop.set(r.shopId, [r]);
  }
  return byShop;
}

/**
 * Keep only the records carrying the proven address, matched the way
 * customerIdentity.ts matches one: trimmed and lowercased. Read in full for the
 * number, because "exactly one at this shop" is the privacy line and a bounded
 * read could hide a shop's second record.
 */
function onPair<T extends { email: string | null }>(rows: T[], email: string): T[] {
  return rows.filter((r) => normalizeEmail(r.email) === email);
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
 * answer, and it is safe to answer here because the caller has just proven the
 * address the answer is about. The boundary:
 *
 *   - runs only behind a live, unconsumed recovery proof;
 *   - matches ONLY records with BOTH the typed number AND the proven address -
 *     no shop ids, filters or search terms are accepted from the caller;
 *   - fixed minimal select: public name, logo, business type, city/state.
 *     Never balances, visits, appointments, phone numbers, internal ids or
 *     configuration - the select below is the whole contract;
 *   - one row per shop, bounded count, deterministic order.
 *
 * An archived row is simply absent - no reason, no count, nothing to infer from.
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
    const pair = openPair(row.phoneEnc);
    if (!pair) return null;

    const clients = onPair(
      await tx.client.findMany({
        where: { phone: pair.phone, archivedAt: null },
        // Fixed minimal select - THE contract. Adding a field here is a privacy
        // decision, not a convenience. `email` is read to match and never returned.
        select: {
          id: true,
          shopId: true,
          email: true,
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
      }),
      pair.email,
    );

    // One entry per shop.
    //
    // 🔴 A SHOP WITH MORE THAN ONE RECORD FOR THIS PAIR GETS NO SELECTION.
    // This used to collapse the rows onto the FIRST by id and hand out THAT
    // record's link - so whoever verified was sent the other person's rewards.
    // Nothing about the pair can say which of them is asking, so no record is
    // chosen: the shop is listed as ambiguous and the page tells them to ask it
    // for their own link.
    return [...groupByShop(clients).values()]
      .map((rows) => {
        const c = rows[0]!;
        const ambiguous = rows.length > 1;
        return {
          selectionId: ambiguous ? null : selectionIdFor(proofHash, c.id),
          ambiguous,
          name: c.shop.name,
          logoUrl: c.shop.logoUrl,
          industry: c.shop.industry,
          city: c.shop.addressCity,
          region: c.shop.addressRegion,
        };
      })
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name) || (a.selectionId ?? "").localeCompare(b.selectionId ?? ""),
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
    const pair = openPair(row.phoneEnc);
    if (!pair) return { ok: false };

    // Resolve the selection against the same eligibility the chooser used.
    const clients = onPair(
      await tx.client.findMany({
        where: { phone: pair.phone, archivedAt: null },
        select: { id: true, shopId: true, email: true, magicToken: true },
        orderBy: { id: "asc" },
      }),
      pair.email,
    );
    // 🔴 Only a shop with exactly ONE record for this pair can be chosen - the
    // chooser offers nothing else, and this refuses anything else even for a
    // selection id computed some other way (an older page, a replay). Refusing
    // does not spend the proof: their other shops still open.
    const chosen = [...groupByShop(clients).values()]
      .filter((rows) => rows.length === 1)
      .map((rows) => rows[0]!)
      .find((c) => selectionIdFor(proofHash, c.id) === selectionId);
    if (!chosen) return { ok: false };

    // Exactly one winner - the CAS is the arbiter, and it happens BEFORE the
    // credential leaves this function.
    const spent = await tx.phoneRecoveryCode.updateMany({
      where: { id: row.id, proofConsumedAt: null },
      data: { proofConsumedAt: now },
    });
    if (spent.count === 0) return { ok: false };

    // Ids only - the phone and address never reach a log line.
    logger.info(
      { shopId: chosen.shopId, clientId: chosen.id },
      "rewards recovery: shop selected",
    );
    const base = apiEnv().APP_BASE_URL.replace(/\/$/, "");
    return { ok: true, rewardsUrl: `${base}/r/${chosen.magicToken}/rewards` };
  });
}
