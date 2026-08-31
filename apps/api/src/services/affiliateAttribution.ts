import type { Prisma } from "@chairback/db";
import { runAsOwner } from "@chairback/db";
import {
  AFFILIATE_CLAIM_KEY_VERSION,
  AFFILIATE_CLAIM_TTL_SECONDS,
  AFFILIATE_POLICY,
  apiEnv,
  createAffiliateClaim,
  normalizeAffiliateCode,
  verifyAffiliateClaim,
  type AffiliateClaimKeyring,
  type AffiliateClaimSource,
} from "@chairback/config";
import { logger } from "../logger.js";
import { recordAffiliateEvent } from "./affiliateAudit.js";

/**
 * Affiliate attribution: from a referral link to a durable outcome on the
 * referred shop.
 *
 * THE SHAPE OF IT
 *  1. A visitor opens /join?ref=CODE. The web app asks this service to
 *     validate the code; a valid, ACTIVE affiliate gets a signed claim minted
 *     and the web app parks it in an HttpOnly cookie on its own origin.
 *  2. The visitor signs up through ANY door and reaches onboarding.
 *  3. Shop creation (the one and only POST /api/shops) resolves the claim and
 *     writes the attribution INSIDE the shop's transaction.
 *
 * 🔴 WHY THE LOCK IS AT SHOP CREATION AND NOWHERE EARLIER
 * A visit is not a business and a user account is not a business - only a Shop
 * is. Locking there also means attribution never has to survive the OAuth
 * round trip: the claim cookie belongs to the WEB origin, the web server
 * forwards its cookies when it calls POST /api/shops, and Google and Apple
 * never see or carry it. Nothing is added to the OAuth `state`, so the
 * provider's CSRF boundary is exactly as strong as it was, a cancelled or
 * replayed OAuth flow cannot consume a claim (only creating a shop can), and
 * a provider that echoed back a referral parameter of its own would not be
 * read by anything here.
 *
 * 🔴 FAILURE POLICY, stated explicitly because the two rules pull apart:
 * validation happens BEFORE the transaction and can never fail it (any error
 * is treated as "no claim"), while the single row is written INSIDE the
 * transaction so a committed shop always carries its attribution outcome. An
 * ineligible affiliate produces a durable REJECTED row rather than a silent
 * drop. A forged or malformed claim produces nothing - it was never a claim.
 */

/** Fixed rejection classifications. Mirrors the migration's CHECK. */
export type AttributionRejection =
  | "unknown_code"
  | "affiliate_suspended"
  | "self_referral"
  | "claim_expired"
  /** The legacy program is about to claim this shop; it stays authoritative. */
  | "legacy_claimed";

export interface AttributionPlan {
  state: "ATTRIBUTED" | "REJECTED";
  affiliateAccountId: string | null;
  /** The affiliate's own shop - only known when the code resolved. */
  affiliateShopId: string | null;
  codeUsed: string;
  source: AffiliateClaimSource;
  rejectionReason: AttributionRejection | null;
  capturedAt: Date;
  claimExpiresAt: Date;
}

/** True while the program's master switch is on. Everything here is inert
 *  otherwise: no claim is minted, no cookie is read, no row is written. */
export function affiliateAttributionEnabled(): boolean {
  return apiEnv().AFFILIATE_PROGRAM_ENABLED;
}

/**
 * The claim signing keyring, version -> secret.
 *
 * One entry today. Rotation is: mint under a new version while the old secret
 * still verifies here, then drop the old entry once the window has passed -
 * at which point claims signed with it fail closed rather than silently
 * downgrading.
 */
function keyring(): AffiliateClaimKeyring {
  return { [AFFILIATE_CLAIM_KEY_VERSION]: apiEnv().SESSION_SECRET };
}

/**
 * Validate a public referral code and mint a claim for it.
 *
 * Returns null for every failure - unknown code, suspended affiliate,
 * malformed input - so the caller has nothing to distinguish and the public
 * response can stay neutral. Never reveals whether an affiliate exists.
 */
export async function captureClaim(params: {
  rawCode: unknown;
  source: AffiliateClaimSource;
  nowMs?: number;
}): Promise<{ claim: string; maxAgeSeconds: number } | null> {
  if (!affiliateAttributionEnabled()) return null;
  const code = normalizeAffiliateCode(params.rawCode);
  if (!code) return null;

  const nowMs = params.nowMs ?? Date.now();
  const account = await runAsOwner((tx) =>
    tx.affiliateAccount.findUnique({
      where: { code },
      select: { id: true, status: true },
    }),
  );
  // Unknown and suspended are the same answer to the outside world.
  if (!account || account.status !== "ACTIVE") return null;

  await bumpClickCounter(account.id, nowMs);

  return {
    claim: createAffiliateClaim({
      code,
      source: params.source,
      secret: apiEnv().SESSION_SECRET,
      nowSeconds: Math.floor(nowMs / 1000),
    }),
    maxAgeSeconds: AFFILIATE_CLAIM_TTL_SECONDS,
  };
}

/**
 * One row per affiliate per UTC day, incremented in place. Bounded by
 * construction, and it records nothing about WHO clicked: no IP, no user
 * agent, no visitor id, so there is no abuse key to hash and nothing whose
 * retention needs bounding.
 *
 * Best-effort: a counter must never cost a visitor their attribution.
 */
async function bumpClickCounter(accountId: string, nowMs: number): Promise<void> {
  const day = new Date(nowMs);
  day.setUTCHours(0, 0, 0, 0);
  try {
    await runAsOwner((tx) =>
      tx.affiliateClickDay.upsert({
        where: { affiliateAccountId_day: { affiliateAccountId: accountId, day } },
        create: { affiliateAccountId: accountId, day, count: 1 },
        update: { count: { increment: 1 } },
      }),
    );
  } catch (err) {
    // A CLASSIFICATION, never the error object: a Prisma error carries the
    // failing query's parameters, which here would be the referral code. Ids
    // and a name only - never the code, never the claim.
    logger.warn(
      { accountId, errName: err instanceof Error ? err.name : "unknown" },
      "affiliate: click counter bump failed",
    );
  }
}

/**
 * Decide what this shop's attribution outcome is, BEFORE the shop transaction
 * opens. Returns null when there is nothing durable to record: the program is
 * off, no claim was presented, or the value presented was not a claim we
 * signed. Never throws - a failure here is "no attribution", never a failed
 * shop creation.
 */
export async function planAttribution(params: {
  claimToken: string | undefined;
  ownerId: string;
  nowMs?: number;
}): Promise<AttributionPlan | null> {
  if (!affiliateAttributionEnabled()) return null;
  if (!params.claimToken) return null;

  const nowMs = params.nowMs ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  try {
    // allowExpired so a genuine-but-stale claim can be told apart from a
    // forgery; the expiry decision is made explicitly below.
    const claim = verifyAffiliateClaim(params.claimToken, keyring(), nowSeconds, {
      allowExpired: true,
    });
    // Forged, tampered, wrong key, malformed: not a claim, nothing recorded.
    if (!claim) return null;

    const base = {
      codeUsed: claim.code,
      source: claim.src,
      capturedAt: new Date(claim.iat * 1000),
      claimExpiresAt: new Date(claim.exp * 1000),
    };

    if (claim.exp <= nowSeconds) {
      return {
        ...base,
        state: "REJECTED",
        affiliateAccountId: null,
        affiliateShopId: null,
        rejectionReason: "claim_expired",
      };
    }

    // 🔴 LEGACY WINS, ALWAYS. The legacy referral program links its own row
    // just after this shop's transaction commits, using the code this owner
    // arrived with. If that code resolves to a real referrer, legacy is about
    // to claim this shop - so the new system records a rejection and never
    // touches it. That is what makes "a referred shop cannot be claimable in
    // both systems" true structurally rather than by scheduling, and it holds
    // for as long as the two programs coexist.
    const legacyClaimant = await runAsOwner(async (tx) => {
      const owner = await tx.user.findUnique({
        where: { id: params.ownerId },
        select: { referralCode: true },
      });
      const legacyCode = owner?.referralCode?.trim();
      if (!legacyCode) return null;
      return tx.shop.findUnique({
        where: { referralCode: legacyCode },
        select: { id: true },
      });
    });
    if (legacyClaimant) {
      return {
        ...base,
        state: "REJECTED",
        affiliateAccountId: null,
        affiliateShopId: null,
        rejectionReason: "legacy_claimed",
      };
    }

    const account = await runAsOwner((tx) =>
      tx.affiliateAccount.findUnique({
        where: { code: claim.code },
        select: {
          id: true,
          status: true,
          shopId: true,
          shop: { select: { ownerId: true } },
        },
      }),
    );
    if (!account) {
      // Includes a code that was rotated after capture: the old code no longer
      // resolves, so the stale claim is refused rather than following the
      // rotation to whoever holds the new one.
      return {
        ...base,
        state: "REJECTED",
        affiliateAccountId: null,
        affiliateShopId: null,
        rejectionReason: "unknown_code",
      };
    }
    if (account.status !== "ACTIVE") {
      return {
        ...base,
        state: "REJECTED",
        affiliateAccountId: account.id,
        affiliateShopId: account.shopId,
        rejectionReason: "affiliate_suspended",
      };
    }
    if (account.shop.ownerId === params.ownerId) {
      return {
        ...base,
        state: "REJECTED",
        affiliateAccountId: account.id,
        affiliateShopId: account.shopId,
        rejectionReason: "self_referral",
      };
    }
    return {
      ...base,
      state: "ATTRIBUTED",
      affiliateAccountId: account.id,
      affiliateShopId: account.shopId,
      rejectionReason: null,
    };
  } catch (err) {
    // A lookup failure must not cost the customer their shop. The error object
    // itself is NOT logged: a Prisma error embeds the failing query's
    // parameters, and here that is the referral code.
    logger.warn(
      { errName: err instanceof Error ? err.name : "unknown" },
      "affiliate: attribution planning failed; not attributed",
    );
    return null;
  }
}

/**
 * Write the planned outcome inside the shop's own transaction.
 *
 * createMany + skipDuplicates rather than create: the unique index on
 * referredShopId is what makes two racing shop creations produce one
 * attribution, and a caught P2002 would NOT un-abort the surrounding Postgres
 * transaction - it would take the shop down with it. `count === 0` IS the
 * duplicate signal.
 */
export async function applyAttributionInTx(
  tx: Prisma.TransactionClient,
  plan: AttributionPlan,
  referredShopId: string,
  nowMs?: number,
): Promise<boolean> {
  const lockedAt = new Date(nowMs ?? Date.now());
  const { count } = await tx.affiliateReferralAttribution.createMany({
    data: [
      {
        affiliateAccountId: plan.affiliateAccountId,
        referredShopId,
        codeUsed: plan.codeUsed,
        source: plan.source,
        state: plan.state,
        rejectionReason: plan.rejectionReason,
        capturedAt: plan.capturedAt,
        lockedAt,
        claimExpiresAt: plan.claimExpiresAt,
      },
    ],
    skipDuplicates: true,
  });
  if (count === 0) return false;

  // Audit the LOCK only when one actually happened and we know whose it is.
  // A rejected outcome is durable in the attribution row itself; inventing an
  // audit row for it would need an affiliate shop id we may not have.
  if (plan.state === "ATTRIBUTED" && plan.affiliateShopId) {
    await recordAffiliateEvent(tx, {
      shopId: plan.affiliateShopId,
      accountId: plan.affiliateAccountId,
      type: "attribution.locked",
      actor: { type: "system" },
      metadata: { toStatus: "ATTRIBUTED", source: plan.source },
    });
  }
  return true;
}

export type CorrectionError =
  | "not_found"
  | "invalid_transition"
  | "correction_window_closed"
  | "unknown_code"
  | "self_referral";

/**
 * The ONE legal way an attribution changes after the lock: a platform admin
 * moves it to a different affiliate, within the policy window, with a written
 * reason, and it is audited.
 *
 * The database trigger already refuses to let the locked facts (which shop,
 * which code, when it was captured) move at all, and refuses a reassignment
 * that does not record a correction. This adds the parts a trigger cannot
 * know: the seven-day window, that the new affiliate is real and eligible,
 * and the append-only event naming the previous and new value.
 */
export async function correctAttribution(params: {
  attributionId: string;
  newCode: string;
  reason: string;
  adminUserId: string;
  nowMs?: number;
}): Promise<
  | { ok: true; value: { attributionId: string; newAffiliateAccountId: string } }
  | { ok: false; error: CorrectionError }
> {
  const nowMs = params.nowMs ?? Date.now();
  const code = normalizeAffiliateCode(params.newCode);
  if (!code) return { ok: false, error: "unknown_code" };

  return runAsOwner(async (tx) => {
    const row = await tx.affiliateReferralAttribution.findUnique({
      where: { id: params.attributionId },
      select: {
        id: true,
        state: true,
        lockedAt: true,
        affiliateAccountId: true,
        referredShopId: true,
      },
    });
    if (!row) return { ok: false as const, error: "not_found" as const };
    // A rejection stays a rejection: correcting one would have to invent an
    // attribution that never happened.
    if (row.state !== "ATTRIBUTED") {
      return { ok: false as const, error: "invalid_transition" as const };
    }

    const windowMs =
      AFFILIATE_POLICY.attribution.adminCorrectionWindowDays * 86_400_000;
    if (nowMs - row.lockedAt.getTime() > windowMs) {
      return { ok: false as const, error: "correction_window_closed" as const };
    }

    const account = await tx.affiliateAccount.findUnique({
      where: { code },
      select: { id: true, status: true, shop: { select: { ownerId: true } } },
    });
    // Unknown and suspended are one answer here too - an admin correcting an
    // attribution has no business learning which of the two it was from this
    // endpoint.
    if (!account || account.status !== "ACTIVE") {
      return { ok: false as const, error: "unknown_code" as const };
    }
    if (account.id === row.affiliateAccountId) {
      return { ok: false as const, error: "invalid_transition" as const };
    }

    const referred = await tx.shop.findUnique({
      where: { id: row.referredShopId },
      select: { ownerId: true },
    });
    if (referred && referred.ownerId === account.shop.ownerId) {
      return { ok: false as const, error: "self_referral" as const };
    }

    await tx.affiliateReferralAttribution.update({
      where: { id: row.id },
      data: {
        affiliateAccountId: account.id,
        previousAffiliateAccountId: row.affiliateAccountId,
        correctedAt: new Date(nowMs),
        correctedByUserId: params.adminUserId,
        correctionReason: params.reason,
      },
    });

    await recordAffiliateEvent(tx, {
      shopId: row.referredShopId,
      accountId: account.id,
      type: "attribution.corrected",
      actor: { type: "admin", userId: params.adminUserId },
      metadata: {
        previousAccountId: row.affiliateAccountId,
        newAccountId: account.id,
      },
    });

    return {
      ok: true as const,
      value: { attributionId: row.id, newAffiliateAccountId: account.id },
    };
  });
}
