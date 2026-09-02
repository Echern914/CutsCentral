import { Prisma, runAsOwner } from "@chairback/db";
import {
  AFFILIATE_CODE_BYTES,
  AFFILIATE_DECISION_PUBLIC_COPY,
  AFFILIATE_POLICY_VERSION,
  AFFILIATE_TERMS_VERSION,
  randomToken,
  type AffiliateDecisionReason,
  type AffiliateSuspensionReason,
} from "@chairback/config";
import { recordAffiliateEvent } from "./affiliateAudit.js";
import { enqueueAffiliateEmail } from "./affiliateNotify.js";

/**
 * Affiliate program lifecycle: apply -> review -> account, plus suspension.
 *
 * Every function here runs as the OWNER (runAsOwner) because all three
 * affiliate tables are default-deny - the app role holds zero privileges on
 * them, so nothing tenant-scoped (runWithShop, forShop, the MCP tools) can
 * ever read an internalNote by accident. The flip side of that bargain: shop
 * identity comes ONLY from the caller's session (req.shop.id), never from
 * client input, and owner-facing reads go through toOwnerView() so
 * admin-internal fields cannot leak.
 *
 * Every transition is a CAS (updateMany gated on the expected FROM status)
 * inside one transaction that also writes the audit event - a decision and
 * its audit row commit together, and a replay answers `invalid_transition`
 * instead of double-acting.
 */

/** Everything the ADMIN surface may see. */
const APPLICATION_ADMIN_SELECT = {
  id: true,
  shopId: true,
  status: true,
  promotionChannels: true,
  audienceDescription: true,
  links: true,
  promotionPlan: true,
  ftcAcknowledgedAt: true,
  acceptedTermsVersion: true,
  acceptedTermsAt: true,
  decidedAt: true,
  decidedByUserId: true,
  decisionReason: true,
  internalNote: true,
  createdAt: true,
} satisfies Prisma.AffiliateApplicationSelect;

type ApplicationAdminRow = Prisma.AffiliateApplicationGetPayload<{
  select: typeof APPLICATION_ADMIN_SELECT;
}>;

/** The OWNER-facing view of an application: applicant-safe fields only. */
export interface OwnerApplicationView {
  id: string;
  status: string;
  submittedAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
  /** Derived from the fixed classification - never admin free text. */
  publicMessage: string | null;
}

export interface OwnerAccountView {
  code: string;
  status: string;
  createdAt: string;
}

export interface OwnerAffiliateStatus {
  termsVersion: string;
  application: OwnerApplicationView | null;
  account: OwnerAccountView | null;
}

/**
 * Mask an application row for its own applicant. The absence list is the
 * contract: internalNote and decidedByUserId must never appear, and the
 * public message is derived from the classification, not stored.
 */
export function toOwnerView(row: {
  id: string;
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
  decisionReason: string | null;
}): OwnerApplicationView {
  const publicMessage =
    row.status === "REJECTED" && row.decisionReason
      ? (AFFILIATE_DECISION_PUBLIC_COPY[
          row.decisionReason as AffiliateDecisionReason
        ] ?? AFFILIATE_DECISION_PUBLIC_COPY.other)
      : null;
  return {
    id: row.id,
    status: row.status,
    submittedAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.status === "REJECTED" ? row.decisionReason : null,
    publicMessage,
  };
}

/** The owner's own program status: latest application + account, masked. */
export async function getAffiliateStatus(
  shopId: string,
): Promise<OwnerAffiliateStatus> {
  return runAsOwner(async (tx) => {
    const [application, account] = await Promise.all([
      tx.affiliateApplication.findFirst({
        where: { shopId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          createdAt: true,
          decidedAt: true,
          decisionReason: true,
        },
      }),
      tx.affiliateAccount.findUnique({
        where: { shopId },
        select: { code: true, status: true, createdAt: true },
      }),
    ]);
    return {
      termsVersion: AFFILIATE_TERMS_VERSION,
      application: application ? toOwnerView(application) : null,
      account: account
        ? {
            code: account.code,
            status: account.status,
            createdAt: account.createdAt.toISOString(),
          }
        : null,
    };
  });
}

export type SubmitResult =
  | { ok: true; application: OwnerApplicationView }
  | {
      ok: false;
      error: "application_pending" | "already_affiliate" | "affiliate_suspended";
    };

export interface SubmitApplicationInput {
  shopId: string;
  userId: string;
  promotionChannels: string[];
  audienceDescription: string;
  links: string[];
  promotionPlan: string;
}

/**
 * Submit an application. The PENDING partial unique index is the double-submit
 * guard: two concurrent submits race to one INSERT winner in Postgres, and the
 * loser's unique violation maps to `application_pending`. No
 * pre-check-then-insert - two racing pre-checks both pass.
 */
export async function submitApplication(
  input: SubmitApplicationInput,
): Promise<SubmitResult> {
  const now = new Date();
  try {
    return await runAsOwner(async (tx) => {
      // An existing account decides the answer before a new row is attempted.
      const account = await tx.affiliateAccount.findUnique({
        where: { shopId: input.shopId },
        select: { status: true },
      });
      if (account) {
        return {
          ok: false as const,
          error:
            account.status === "SUSPENDED"
              ? ("affiliate_suspended" as const)
              : ("already_affiliate" as const),
        };
      }
      const application = await tx.affiliateApplication.create({
        data: {
          shopId: input.shopId,
          submittedByUserId: input.userId,
          promotionChannels: input.promotionChannels,
          audienceDescription: input.audienceDescription,
          links: input.links,
          promotionPlan: input.promotionPlan,
          ftcAcknowledgedAt: now,
          acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
          acceptedTermsAt: now,
          acceptedTermsSource: "dashboard",
        },
        select: {
          id: true,
          status: true,
          createdAt: true,
          decidedAt: true,
          decisionReason: true,
        },
      });
      await recordAffiliateEvent(tx, {
        shopId: input.shopId,
        applicationId: application.id,
        type: "application.submitted",
        actor: { type: "applicant", userId: input.userId },
        metadata: {
          toStatus: "PENDING",
          termsVersion: AFFILIATE_TERMS_VERSION,
          source: "dashboard",
        },
      });
      return { ok: true as const, application: toOwnerView(application) };
    });
  } catch (err) {
    // The partial unique index (one PENDING per shop) lost us the race.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return { ok: false, error: "application_pending" };
    }
    throw err;
  }
}

/** Mint an unguessable public code, retrying the astronomically unlikely
 *  collision. Bounded so a systemic failure surfaces instead of spinning. */
export function mintAffiliateCode(): string {
  return randomToken(AFFILIATE_CODE_BYTES);
}

export type AdminActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: "not_found" | "invalid_transition" | "already_affiliate" };

/** Approve: PENDING -> APPROVED, minting the account + code atomically. */
export async function approveApplication(params: {
  applicationId: string;
  adminUserId: string;
  internalNote?: string;
}): Promise<
  AdminActionResult<{
    application: ApplicationAdminRow;
    account: { id: string; code: string; status: string };
  }>
> {
  const MINT_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MINT_ATTEMPTS; attempt++) {
    const code = mintAffiliateCode();
    try {
      return await runAsOwner(async (tx) => {
        const existing = await tx.affiliateApplication.findUnique({
          where: { id: params.applicationId },
          select: { id: true, shopId: true, status: true },
        });
        if (!existing) return { ok: false as const, error: "not_found" as const };

        // One account per shop, ever - checked in-tx so a second PENDING
        // application (impossible today, cheap to guard anyway) cannot mint a
        // second account. The shopId unique index backs this up structurally.
        const account = await tx.affiliateAccount.findUnique({
          where: { shopId: existing.shopId },
          select: { id: true },
        });
        if (account) {
          return { ok: false as const, error: "already_affiliate" as const };
        }

        const { count } = await tx.affiliateApplication.updateMany({
          where: { id: params.applicationId, status: "PENDING" },
          data: {
            status: "APPROVED",
            decidedAt: new Date(),
            decidedByUserId: params.adminUserId,
            decisionReason: "approved",
            ...(params.internalNote !== undefined
              ? { internalNote: params.internalNote }
              : {}),
          },
        });
        if (count === 0) {
          return { ok: false as const, error: "invalid_transition" as const };
        }

        const created = await tx.affiliateAccount.create({
          data: {
            shopId: existing.shopId,
            applicationId: existing.id,
            code,
            acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
            policyVersion: AFFILIATE_POLICY_VERSION,
          },
          select: { id: true, code: true, status: true },
        });
        await recordAffiliateEvent(tx, {
          shopId: existing.shopId,
          applicationId: existing.id,
          accountId: created.id,
          type: "application.approved",
          actor: { type: "admin", userId: params.adminUserId },
          metadata: {
            fromStatus: "PENDING",
            toStatus: "APPROVED",
            termsVersion: AFFILIATE_TERMS_VERSION,
            policyVersion: AFFILIATE_POLICY_VERSION,
          },
        });
        // The "you're in" email, in the SAME transaction as the approval.
        await enqueueAffiliateEmail(tx, {
          kind: "affiliate_approved",
          affiliateShopId: existing.shopId,
          subjectId: existing.id,
        });
        const application = await tx.affiliateApplication.findUniqueOrThrow({
          where: { id: existing.id },
          select: APPLICATION_ADMIN_SELECT,
        });
        return { ok: true as const, value: { application, account: created } };
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" &&
        attempt < MINT_ATTEMPTS
      ) {
        continue; // code collision - mint another and retry the whole tx
      }
      throw err;
    }
  }
  // Unreachable: the loop either returns or throws on its last attempt.
  throw new Error("affiliate code mint exhausted retries");
}

/** Reject: PENDING -> REJECTED with a fixed classification. */
export async function rejectApplication(params: {
  applicationId: string;
  adminUserId: string;
  decisionReason: AffiliateDecisionReason;
  internalNote?: string;
}): Promise<AdminActionResult<{ application: ApplicationAdminRow }>> {
  return runAsOwner(async (tx) => {
    const existing = await tx.affiliateApplication.findUnique({
      where: { id: params.applicationId },
      select: { id: true, shopId: true },
    });
    if (!existing) return { ok: false as const, error: "not_found" as const };

    const { count } = await tx.affiliateApplication.updateMany({
      where: { id: params.applicationId, status: "PENDING" },
      data: {
        status: "REJECTED",
        decidedAt: new Date(),
        decidedByUserId: params.adminUserId,
        decisionReason: params.decisionReason,
        ...(params.internalNote !== undefined
          ? { internalNote: params.internalNote }
          : {}),
      },
    });
    if (count === 0) {
      return { ok: false as const, error: "invalid_transition" as const };
    }
    await recordAffiliateEvent(tx, {
      shopId: existing.shopId,
      applicationId: existing.id,
      type: "application.rejected",
      actor: { type: "admin", userId: params.adminUserId },
      metadata: {
        fromStatus: "PENDING",
        toStatus: "REJECTED",
        decisionReason: params.decisionReason,
      },
    });
    await enqueueAffiliateEmail(tx, {
      kind: "affiliate_rejected",
      affiliateShopId: existing.shopId,
      subjectId: existing.id,
    });
    const application = await tx.affiliateApplication.findUniqueOrThrow({
      where: { id: existing.id },
      select: APPLICATION_ADMIN_SELECT,
    });
    return { ok: true as const, value: { application } };
  });
}

const ACCOUNT_ADMIN_SELECT = {
  id: true,
  shopId: true,
  applicationId: true,
  code: true,
  status: true,
  suspendedAt: true,
  suspensionReason: true,
  reactivatedAt: true,
  internalNote: true,
  acceptedTermsVersion: true,
  policyVersion: true,
  createdAt: true,
} satisfies Prisma.AffiliateAccountSelect;

type AccountAdminRow = Prisma.AffiliateAccountGetPayload<{
  select: typeof ACCOUNT_ADMIN_SELECT;
}>;

/** Suspend: ACTIVE -> SUSPENDED. History (rows, code, audit) stays untouched. */
export async function suspendAccount(params: {
  accountId: string;
  adminUserId: string;
  suspensionReason: AffiliateSuspensionReason;
  internalNote?: string;
}): Promise<AdminActionResult<{ account: AccountAdminRow }>> {
  return runAsOwner(async (tx) => {
    const existing = await tx.affiliateAccount.findUnique({
      where: { id: params.accountId },
      select: { id: true, shopId: true },
    });
    if (!existing) return { ok: false as const, error: "not_found" as const };

    const { count } = await tx.affiliateAccount.updateMany({
      where: { id: params.accountId, status: "ACTIVE" },
      data: {
        status: "SUSPENDED",
        suspendedAt: new Date(),
        suspensionReason: params.suspensionReason,
        ...(params.internalNote !== undefined
          ? { internalNote: params.internalNote }
          : {}),
      },
    });
    if (count === 0) {
      return { ok: false as const, error: "invalid_transition" as const };
    }
    await recordAffiliateEvent(tx, {
      shopId: existing.shopId,
      accountId: existing.id,
      type: "account.suspended",
      actor: { type: "admin", userId: params.adminUserId },
      metadata: {
        fromStatus: "ACTIVE",
        toStatus: "SUSPENDED",
        suspensionReason: params.suspensionReason,
      },
    });
    const account = await tx.affiliateAccount.findUniqueOrThrow({
      where: { id: existing.id },
      select: ACCOUNT_ADMIN_SELECT,
    });
    return { ok: true as const, value: { account } };
  });
}

/** Reactivate: SUSPENDED -> ACTIVE. */
export async function reactivateAccount(params: {
  accountId: string;
  adminUserId: string;
  internalNote?: string;
}): Promise<AdminActionResult<{ account: AccountAdminRow }>> {
  return runAsOwner(async (tx) => {
    const existing = await tx.affiliateAccount.findUnique({
      where: { id: params.accountId },
      select: { id: true, shopId: true },
    });
    if (!existing) return { ok: false as const, error: "not_found" as const };

    const { count } = await tx.affiliateAccount.updateMany({
      where: { id: params.accountId, status: "SUSPENDED" },
      data: {
        status: "ACTIVE",
        reactivatedAt: new Date(),
        ...(params.internalNote !== undefined
          ? { internalNote: params.internalNote }
          : {}),
      },
    });
    if (count === 0) {
      return { ok: false as const, error: "invalid_transition" as const };
    }
    await recordAffiliateEvent(tx, {
      shopId: existing.shopId,
      accountId: existing.id,
      type: "account.reactivated",
      actor: { type: "admin", userId: params.adminUserId },
      metadata: { fromStatus: "SUSPENDED", toStatus: "ACTIVE" },
    });
    const account = await tx.affiliateAccount.findUniqueOrThrow({
      where: { id: existing.id },
      select: ACCOUNT_ADMIN_SELECT,
    });
    return { ok: true as const, value: { account } };
  });
}

/** The admin review queue, oldest first (the person waiting longest is next). */
export async function listApplications(params: {
  status: "PENDING" | "APPROVED" | "REJECTED";
}): Promise<Array<ApplicationAdminRow & { shopName: string; ownerEmail: string }>> {
  return runAsOwner(async (tx) => {
    const rows = await tx.affiliateApplication.findMany({
      where: { status: params.status },
      orderBy: { createdAt: "asc" },
      take: 100,
      select: {
        ...APPLICATION_ADMIN_SELECT,
        shop: { select: { name: true, owner: { select: { email: true } } } },
      },
    });
    return rows.map(({ shop, ...row }) => ({
      ...row,
      shopName: shop.name,
      ownerEmail: shop.owner.email,
    }));
  });
}

/** One application, full admin detail, plus the account it minted (if any). */
export async function getApplicationForAdmin(applicationId: string): Promise<
  | (ApplicationAdminRow & {
      shopName: string;
      ownerEmail: string;
      account: { id: string; code: string; status: string } | null;
    })
  | null
> {
  return runAsOwner(async (tx) => {
    const row = await tx.affiliateApplication.findUnique({
      where: { id: applicationId },
      select: {
        ...APPLICATION_ADMIN_SELECT,
        shop: { select: { name: true, owner: { select: { email: true } } } },
      },
    });
    if (!row) return null;
    const account = await tx.affiliateAccount.findUnique({
      where: { applicationId },
      select: { id: true, code: true, status: true },
    });
    const { shop, ...rest } = row;
    return {
      ...rest,
      shopName: shop.name,
      ownerEmail: shop.owner.email,
      account,
    };
  });
}

/** Admin account list. */
export async function listAccounts(params: {
  status?: "ACTIVE" | "SUSPENDED";
}): Promise<Array<AccountAdminRow & { shopName: string }>> {
  return runAsOwner(async (tx) => {
    const rows = await tx.affiliateAccount.findMany({
      where: params.status ? { status: params.status } : {},
      orderBy: { createdAt: "asc" },
      take: 100,
      select: { ...ACCOUNT_ADMIN_SELECT, shop: { select: { name: true } } },
    });
    return rows.map(({ shop, ...row }) => ({ ...row, shopName: shop.name }));
  });
}
