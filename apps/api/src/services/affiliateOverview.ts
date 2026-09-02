import { runAsOwner } from "@chairback/db";
import {
  AFFILIATE_POLICY,
  AFFILIATE_REVERSAL_PUBLIC_COPY,
  AFFILIATE_SUSPENSION_PUBLIC_COPY,
  AFFILIATE_TERMS_VERSION,
  affiliateMonths,
  affiliateStage,
  apiEnv,
  maskBusinessLabel,
  type AffiliateMonths,
  type AffiliatePromotionStyle,
  type AffiliateReferralStage,
  type AffiliateReversalReason,
  type AffiliateSuspensionReason,
} from "@chairback/config";
import { recordAffiliateEvent } from "./affiliateAudit.js";

/**
 * The affiliate DASHBOARD's reads and the two small writes around it, plus
 * the operator's ledger views.
 *
 * Same bargain as services/affiliate.ts: every table here is default-deny, so
 * everything runs as the owner and shop identity comes ONLY from the session.
 * The owner-facing shape is built here, field by field, so that nothing about
 * a REFERRED business can leak - no name, no slug, no email, no owner - only
 * the masked label from config. A test pins that with a regex over the whole
 * payload.
 */

export interface OverviewReferral {
  id: string;
  /** "Business ••••1027" - never anything else. */
  label: string;
  stage: AffiliateReferralStage;
  signedUpAt: string;
  qualifyingInvoices: number;
  holdEndsAt: string | null;
  availableAt: string | null;
  expiresAt: string | null;
  reversedAt: string | null;
  /** Derived from the fixed reversal code. Null unless reversed. */
  reversalMessage: string | null;
}

export interface OverviewReward {
  id: string;
  label: string;
  status: string;
  qualifiedAt: string;
  holdEndsAt: string;
  availableAt: string | null;
  expiresAt: string | null;
  reversedAt: string | null;
  reversalMessage: string | null;
}

export interface OwnerAffiliateOverview {
  termsVersion: string;
  account: {
    code: string;
    status: string;
    createdAt: string;
    promotionStyles: AffiliatePromotionStyle[];
    stylesChosenAt: string | null;
    /** Derived from the fixed suspension code. Null while ACTIVE. */
    suspensionMessage: string | null;
  };
  months: AffiliateMonths;
  clicks: { last7Days: number; last30Days: number; allTime: number };
  referrals: OverviewReferral[];
  rewards: OverviewReward[];
  policy: {
    attributionWindowDays: number;
    qualifyingInvoices: number;
    holdDays: number;
    expiryMonths: number;
  };
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function reversalMessage(reason: string | null): string | null {
  if (!reason) return null;
  return (
    AFFILIATE_REVERSAL_PUBLIC_COPY[reason as AffiliateReversalReason] ??
    AFFILIATE_REVERSAL_PUBLIC_COPY.admin_adjustment
  );
}

function utcDayStart(ms: number): Date {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function getAffiliateOverview(
  shopId: string,
  now: Date = new Date(),
): Promise<OwnerAffiliateOverview | null> {
  return runAsOwner(async (tx) => {
    const account = await tx.affiliateAccount.findUnique({
      where: { shopId },
      select: {
        id: true,
        code: true,
        status: true,
        createdAt: true,
        suspensionReason: true,
        promotionStyles: true,
        stylesChosenAt: true,
      },
    });
    if (!account) return null;

    const [attributions, rewards, clickRows] = await Promise.all([
      // ATTRIBUTED only. A REJECTED row (legacy claimed it, self-referral,
      // expired) is not theirs and must not be counted or shown.
      tx.affiliateReferralAttribution.findMany({
        where: { affiliateAccountId: account.id, state: "ATTRIBUTED" },
        orderBy: { lockedAt: "desc" },
        take: 500,
        select: { id: true, referredShopId: true, lockedAt: true },
      }),
      tx.affiliateReward.findMany({
        where: { affiliateAccountId: account.id },
        orderBy: { qualifiedAt: "desc" },
        select: {
          id: true,
          referredShopId: true,
          status: true,
          qualifiedAt: true,
          holdEndsAt: true,
          availableAt: true,
          expiresAt: true,
          reversedAt: true,
          reversalReason: true,
        },
      }),
      tx.affiliateClickDay.findMany({
        where: { affiliateAccountId: account.id },
        select: { day: true, count: true },
      }),
    ]);

    const referredIds = attributions.map((a) => a.referredShopId);
    const invoiceGroups =
      referredIds.length === 0
        ? []
        : await tx.affiliateQualifyingInvoice.groupBy({
            by: ["referredShopId"],
            where: { referredShopId: { in: referredIds } },
            _count: { _all: true },
          });
    const invoicesByShop = new Map(
      invoiceGroups.map((g) => [g.referredShopId, g._count._all] as const),
    );
    const rewardByShop = new Map(rewards.map((r) => [r.referredShopId, r] as const));

    const referrals: OverviewReferral[] = attributions.map((a) => {
      const reward = rewardByShop.get(a.referredShopId) ?? null;
      const qualifyingInvoices = invoicesByShop.get(a.referredShopId) ?? 0;
      return {
        id: a.id,
        label: maskBusinessLabel(a.referredShopId),
        stage: affiliateStage({ qualifyingInvoices, rewardStatus: reward?.status ?? null }),
        signedUpAt: a.lockedAt.toISOString(),
        qualifyingInvoices,
        holdEndsAt: iso(reward?.holdEndsAt),
        availableAt: iso(reward?.availableAt),
        expiresAt: iso(reward?.expiresAt),
        reversedAt: iso(reward?.reversedAt),
        reversalMessage: reversalMessage(reward?.reversalReason ?? null),
      };
    });

    const day7 = utcDayStart(now.getTime() - 6 * 86_400_000);
    const day30 = utcDayStart(now.getTime() - 29 * 86_400_000);
    const clicks = { last7Days: 0, last30Days: 0, allTime: 0 };
    for (const row of clickRows) {
      clicks.allTime += row.count;
      if (row.day >= day30) clicks.last30Days += row.count;
      if (row.day >= day7) clicks.last7Days += row.count;
    }

    return {
      termsVersion: AFFILIATE_TERMS_VERSION,
      account: {
        code: account.code,
        status: account.status,
        createdAt: account.createdAt.toISOString(),
        promotionStyles: account.promotionStyles as AffiliatePromotionStyle[],
        stylesChosenAt: iso(account.stylesChosenAt),
        suspensionMessage:
          account.status === "SUSPENDED"
            ? (AFFILIATE_SUSPENSION_PUBLIC_COPY[
                account.suspensionReason as AffiliateSuspensionReason
              ] ?? AFFILIATE_SUSPENSION_PUBLIC_COPY.other)
            : null,
      },
      months: affiliateMonths(rewards),
      clicks,
      referrals,
      rewards: rewards.map((r) => ({
        id: r.id,
        label: maskBusinessLabel(r.referredShopId),
        status: r.status,
        qualifiedAt: r.qualifiedAt.toISOString(),
        holdEndsAt: r.holdEndsAt.toISOString(),
        availableAt: iso(r.availableAt),
        expiresAt: iso(r.expiresAt),
        reversedAt: iso(r.reversedAt),
        reversalMessage: reversalMessage(r.reversalReason),
      })),
      policy: {
        attributionWindowDays: AFFILIATE_POLICY.attribution.windowDays,
        qualifyingInvoices: AFFILIATE_POLICY.qualification.qualifyingInvoices,
        holdDays: AFFILIATE_POLICY.qualification.holdDaysAfterSecond,
        expiryMonths: AFFILIATE_POLICY.reward.expiryMonthsAfterAvailable,
      },
    };
  });
}

export type SetStylesResult =
  | {
      ok: true;
      account: { promotionStyles: AffiliatePromotionStyle[]; stylesChosenAt: string };
    }
  | { ok: false; error: "not_active" };

/**
 * Choose or change promotion styles. One CAS on {shopId, ACTIVE}: a missing
 * account and a suspended one both land on count 0, and neither gets a
 * different answer - a suspended affiliate is told the same thing the
 * dashboard already shows them.
 */
export async function setAffiliateStyles(params: {
  shopId: string;
  userId: string;
  styles: AffiliatePromotionStyle[];
  now?: Date;
}): Promise<SetStylesResult> {
  const now = params.now ?? new Date();
  return runAsOwner(async (tx) => {
    const { count } = await tx.affiliateAccount.updateMany({
      where: { shopId: params.shopId, status: "ACTIVE" },
      data: { promotionStyles: params.styles, stylesChosenAt: now },
    });
    if (count === 0) return { ok: false as const, error: "not_active" as const };
    const account = await tx.affiliateAccount.findUniqueOrThrow({
      where: { shopId: params.shopId },
      select: { id: true, promotionStyles: true, stylesChosenAt: true },
    });
    await recordAffiliateEvent(tx, {
      shopId: params.shopId,
      accountId: account.id,
      type: "account.styles_set",
      actor: { type: "applicant", userId: params.userId },
      metadata: { source: "dashboard" },
    });
    return {
      ok: true as const,
      account: {
        promotionStyles: account.promotionStyles as AffiliatePromotionStyle[],
        stylesChosenAt: account.stylesChosenAt!.toISOString(),
      },
    };
  });
}

//  Operator side

export interface AdminRewardRow {
  id: string;
  status: string;
  amountCents: number;
  currency: string;
  basisPlan: string;
  qualifiedAt: string;
  holdEndsAt: string;
  availableAt: string | null;
  expiresAt: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
  reviewReason: string | null;
  affiliateAccountId: string;
  affiliateShopName: string;
  referredShopId: string;
  referredShopName: string | null;
}

export async function listRewardsForAdmin(params: {
  status?: string;
}): Promise<AdminRewardRow[]> {
  return runAsOwner(async (tx) => {
    const rows = await tx.affiliateReward.findMany({
      where: params.status ? { status: params.status } : {},
      orderBy: [{ status: "asc" }, { qualifiedAt: "asc" }],
      take: 200,
    });
    if (rows.length === 0) return [];
    const accountIds = [...new Set(rows.map((r) => r.affiliateAccountId))];
    const referredIds = [...new Set(rows.map((r) => r.referredShopId))];
    const [accounts, referred] = await Promise.all([
      tx.affiliateAccount.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, shop: { select: { name: true } } },
      }),
      tx.shop.findMany({
        where: { id: { in: referredIds } },
        select: { id: true, name: true },
      }),
    ]);
    const accountName = new Map(accounts.map((a) => [a.id, a.shop.name] as const));
    const referredName = new Map(referred.map((s) => [s.id, s.name] as const));
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      amountCents: r.amountCents,
      currency: r.currency,
      basisPlan: r.basisPlan,
      qualifiedAt: r.qualifiedAt.toISOString(),
      holdEndsAt: r.holdEndsAt.toISOString(),
      availableAt: iso(r.availableAt),
      expiresAt: iso(r.expiresAt),
      reversedAt: iso(r.reversedAt),
      reversalReason: r.reversalReason,
      reviewReason: r.reviewReason,
      affiliateAccountId: r.affiliateAccountId,
      affiliateShopName: accountName.get(r.affiliateAccountId) ?? "(unknown)",
      referredShopId: r.referredShopId,
      referredShopName: referredName.get(r.referredShopId) ?? null,
    }));
  });
}

export type RewardActionResult =
  | { ok: true; value: { id: string; status: string; availableAt: string | null; expiresAt: string | null } }
  | { ok: false; error: "not_found" | "invalid_transition" };

/**
 * Release a reward the rolling-year rule held back: REVIEW_REQUIRED ->
 * AVAILABLE, starting the same 12-month expiry the hold sweep starts. Only
 * that one FROM state - a PENDING reward is the sweep's to release, on time.
 */
export async function releaseReviewedReward(params: {
  rewardId: string;
  adminUserId: string;
  now?: Date;
}): Promise<RewardActionResult> {
  const now = params.now ?? new Date();
  const expiresAt = new Date(now);
  expiresAt.setUTCMonth(
    expiresAt.getUTCMonth() + AFFILIATE_POLICY.reward.expiryMonthsAfterAvailable,
  );
  return runAsOwner(async (tx) => {
    const reward = await tx.affiliateReward.findUnique({
      where: { id: params.rewardId },
      select: { id: true, referredShopId: true, affiliateAccountId: true },
    });
    if (!reward) return { ok: false as const, error: "not_found" as const };
    const { count } = await tx.affiliateReward.updateMany({
      where: { id: reward.id, status: "REVIEW_REQUIRED" },
      data: { status: "AVAILABLE", availableAt: now, expiresAt, reviewReason: null },
    });
    if (count === 0) return { ok: false as const, error: "invalid_transition" as const };
    await recordAffiliateEvent(tx, {
      shopId: reward.referredShopId,
      accountId: reward.affiliateAccountId,
      type: "reward.available",
      actor: { type: "admin", userId: params.adminUserId },
      metadata: { fromStatus: "REVIEW_REQUIRED", toStatus: "AVAILABLE" },
    });
    return {
      ok: true as const,
      value: {
        id: reward.id,
        status: "AVAILABLE",
        availableAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    };
  });
}

/**
 * Take a reward back by hand. Same FROM set as the engine's refund/dispute
 * path - never one already handed over (RESERVED/APPLIED belong to credit
 * execution) and never one already reversed.
 */
export async function reverseRewardByAdmin(params: {
  rewardId: string;
  adminUserId: string;
  now?: Date;
}): Promise<RewardActionResult> {
  const now = params.now ?? new Date();
  return runAsOwner(async (tx) => {
    const reward = await tx.affiliateReward.findUnique({
      where: { id: params.rewardId },
      select: { id: true, referredShopId: true, affiliateAccountId: true },
    });
    if (!reward) return { ok: false as const, error: "not_found" as const };
    const { count } = await tx.affiliateReward.updateMany({
      where: { id: reward.id, status: { in: ["PENDING", "AVAILABLE", "REVIEW_REQUIRED"] } },
      data: { status: "REVERSED", reversedAt: now, reversalReason: "admin_adjustment" },
    });
    if (count === 0) return { ok: false as const, error: "invalid_transition" as const };
    await recordAffiliateEvent(tx, {
      shopId: reward.referredShopId,
      accountId: reward.affiliateAccountId,
      type: "reward.reversed",
      actor: { type: "admin", userId: params.adminUserId },
      metadata: { toStatus: "REVERSED", reversalReason: "admin_adjustment" },
    });
    return {
      ok: true as const,
      value: { id: reward.id, status: "REVERSED", availableAt: null, expiresAt: null },
    };
  });
}

export interface AffiliateLiability {
  byStatus: Record<string, { rewards: number; cents: number }>;
  /** What could still turn into a credit: PENDING + AVAILABLE + REVIEW_REQUIRED + RESERVED. */
  outstanding: { rewards: number; cents: number };
  accounts: { active: number; suspended: number };
  applicationsPending: number;
}

export async function affiliateLiability(): Promise<AffiliateLiability> {
  return runAsOwner(async (tx) => {
    const [groups, active, suspended, pending] = await Promise.all([
      tx.affiliateReward.groupBy({
        by: ["status"],
        _count: { _all: true },
        _sum: { amountCents: true },
      }),
      tx.affiliateAccount.count({ where: { status: "ACTIVE" } }),
      tx.affiliateAccount.count({ where: { status: "SUSPENDED" } }),
      tx.affiliateApplication.count({ where: { status: "PENDING" } }),
    ]);
    const byStatus: AffiliateLiability["byStatus"] = {};
    const outstanding = { rewards: 0, cents: 0 };
    const OPEN = new Set(["PENDING", "AVAILABLE", "REVIEW_REQUIRED", "RESERVED"]);
    for (const g of groups) {
      const entry = { rewards: g._count._all, cents: g._sum.amountCents ?? 0 };
      byStatus[g.status] = entry;
      if (OPEN.has(g.status)) {
        outstanding.rewards += entry.rewards;
        outstanding.cents += entry.cents;
      }
    }
    return {
      byStatus,
      outstanding,
      accounts: { active, suspended },
      applicationsPending: pending,
    };
  });
}

function csvCell(value: string | number | null): string {
  const s = value === null ? "" : String(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * Accounts and their counts. Ids, codes and numbers only - no shop names, no
 * owner emails - so the file can be handed around without becoming a PII
 * incident. A test greps the output for both.
 */
export async function exportAffiliatesCsv(): Promise<string> {
  return runAsOwner(async (tx) => {
    const accounts = await tx.affiliateAccount.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        shopId: true,
        code: true,
        status: true,
        createdAt: true,
        promotionStyles: true,
      },
    });
    const ids = accounts.map((a) => a.id);
    const [attributions, rewards] = ids.length
      ? await Promise.all([
          tx.affiliateReferralAttribution.groupBy({
            by: ["affiliateAccountId"],
            where: { affiliateAccountId: { in: ids }, state: "ATTRIBUTED" },
            _count: { _all: true },
          }),
          tx.affiliateReward.groupBy({
            by: ["affiliateAccountId", "status"],
            where: { affiliateAccountId: { in: ids } },
            _count: { _all: true },
          }),
        ])
      : [[], []];
    const referrals = new Map(
      attributions.map((g) => [g.affiliateAccountId, g._count._all] as const),
    );
    const rewardCount = (accountId: string, status: string): number =>
      rewards.find((g) => g.affiliateAccountId === accountId && g.status === status)?._count
        ._all ?? 0;

    const header = [
      "accountId",
      "shopId",
      "code",
      "status",
      "createdAt",
      "styles",
      "referrals",
      "rewardsPending",
      "rewardsAvailable",
      "rewardsApplied",
      "rewardsReversed",
      "rewardsReviewRequired",
    ];
    const lines = [header.join(",")];
    for (const a of accounts) {
      lines.push(
        [
          a.id,
          a.shopId,
          a.code,
          a.status,
          a.createdAt.toISOString(),
          a.promotionStyles.join("|"),
          referrals.get(a.id) ?? 0,
          rewardCount(a.id, "PENDING"),
          rewardCount(a.id, "AVAILABLE"),
          rewardCount(a.id, "APPLIED"),
          rewardCount(a.id, "REVERSED"),
          rewardCount(a.id, "REVIEW_REQUIRED"),
        ]
          .map(csvCell)
          .join(","),
      );
    }
    return lines.join("\n") + "\n";
  });
}

export function affiliateFlags(): {
  programEnabled: boolean;
  publicApplicationsEnabled: boolean;
  qualificationEnabled: boolean;
  creditExecutionEnabled: boolean;
} {
  const env = apiEnv();
  return {
    programEnabled: env.AFFILIATE_PROGRAM_ENABLED,
    publicApplicationsEnabled: env.AFFILIATE_PUBLIC_APPLICATIONS_ENABLED,
    qualificationEnabled: env.AFFILIATE_QUALIFICATION_ENABLED,
    creditExecutionEnabled: env.AFFILIATE_CREDIT_EXECUTION_ENABLED,
  };
}
