import { Prisma, asOwnerWithin, prisma, runAsOwner } from "@chairback/db";
import {
  PARTNER_PROGRAM,
  normalizePartnerCode,
  partnerBalance,
  partnerCashoutRefusal,
  partnerInvoiceQualifies,
  partnerUnlock,
  type PartnerCashoutRefusal,
  type PartnerUnlock,
} from "@chairback/config";
import { logger } from "../logger.js";

/**
 * The partner program: a PERSON with a code ("ERIC C") earns a one-time cash
 * reward for each business that signs up with it and then pays for a
 * qualifying plan. The rules are in packages/config/src/partnerProgram.ts;
 * this file only reads and writes rows.
 *
 * THE LIFECYCLE
 *  1. Signup: the owner types a code while creating their business. It is
 *     checked BEFORE the business exists (an unknown code is a 400 the form
 *     shows inline) and the PartnerReferral row is written in the same
 *     transaction as the Shop. referredShopId is unique: one attribution per
 *     business, ever, and never to the partner's own login.
 *  2. Trial: nothing. A trial invoice is $0 and never reaches us.
 *  3. First PAID invoice for a qualifying plan: the reward is set on the row,
 *     once - a compare-and-set on creditedAt IS NULL, with the invoice id
 *     unique. Webhook replays, renewals, a later upgrade or downgrade and a
 *     cancel-and-resubscribe all find creditedAt already set and do nothing.
 *  4. Refund, dispute or credit note against THAT invoice: the reward is
 *     reversed (stops counting toward the balance and the unlock). It is never
 *     credited again.
 *  5. Cashout: the partner asks for $25 or $50 of an unlocked balance; an
 *     admin pays it by hand and marks it paid. Nothing here moves money.
 *
 * 🔴 THE BALANCE IS NEVER STORED. It is derived every time from the rows:
 * credited-and-not-reversed rewards minus cashouts asked for. There is no
 * counter to drift.
 */

export type PartnerCodeError = "unknown_referral_code" | "inactive_referral_code" | "own_referral_code";

export type PartnerCodeResolution =
  | { ok: true; partnerId: string; codeUsed: string }
  | { ok: false; error: PartnerCodeError };

/**
 * Resolve a code typed at signup. Case and spaces don't matter. A code that
 * isn't one, a switched-off partner, and a partner's own code each get their
 * own answer, because the signup form shows the person why.
 */
export async function resolvePartnerCode(
  raw: string,
  ownerUserId: string,
): Promise<PartnerCodeResolution> {
  const codeKey = normalizePartnerCode(raw);
  if (!codeKey) return { ok: false, error: "unknown_referral_code" };
  const partner = await runAsOwner((tx) =>
    tx.partner.findUnique({
      where: { codeKey },
      select: { id: true, userId: true, deactivatedAt: true },
    }),
  );
  if (!partner) return { ok: false, error: "unknown_referral_code" };
  if (partner.deactivatedAt) return { ok: false, error: "inactive_referral_code" };
  if (partner.userId === ownerUserId) return { ok: false, error: "own_referral_code" };
  return { ok: true, partnerId: partner.id, codeUsed: raw.trim() };
}

/**
 * Write the attribution inside the shop-creation transaction, so a committed
 * business always carries it. The LAST statement of that transaction on
 * purpose: asOwnerWithin leaves the connection on the tenant role afterwards.
 */
export async function recordPartnerReferralInTx(
  tx: Prisma.TransactionClient,
  params: { partnerId: string; referredShopId: string; codeUsed: string },
): Promise<void> {
  await asOwnerWithin(tx, (owner) =>
    owner.partnerReferral.createMany({ data: [params], skipDuplicates: true }),
  );
}

/**
 * A paid invoice for this business: set the partner's one-time reward if the
 * plan qualifies and it hasn't been set yet. Idempotent by construction - the
 * update only matches a row whose creditedAt is still null - so Stripe
 * redelivering the event, or a later invoice, finds nothing to do.
 */
export async function creditPartnerReferral(params: {
  shopId: string;
  invoiceId: string;
  plan: string | null;
  amountPaidCents: number;
  paidAt: Date;
}): Promise<boolean> {
  if (!partnerInvoiceQualifies(params.plan, params.amountPaidCents)) return false;
  const { count } = await runAsOwner((tx) =>
    tx.partnerReferral.updateMany({
      where: { referredShopId: params.shopId, creditedAt: null },
      data: {
        creditedAt: params.paidAt,
        creditCents: PARTNER_PROGRAM.rewardCents,
        creditPlan: params.plan,
        creditInvoiceId: params.invoiceId,
      },
    }),
  );
  if (count > 0) {
    logger.info({ shopId: params.shopId, plan: params.plan }, "partner: referral credited");
  }
  return count > 0;
}

export type PartnerReversalReason = "invoice_refunded" | "payment_disputed" | "credit_note";

/** Money from the invoice that earned a reward went back: the reward goes too. Once. */
export async function reversePartnerCredit(
  invoiceId: string,
  reason: PartnerReversalReason,
  now: Date = new Date(),
): Promise<boolean> {
  const { count } = await runAsOwner((tx) =>
    tx.partnerReferral.updateMany({
      where: { creditInvoiceId: invoiceId, reversedAt: null },
      data: { reversedAt: now, reversalReason: reason },
    }),
  );
  if (count > 0) logger.warn({ reason }, "partner: referral reward reversed");
  return count > 0;
}

export interface PartnerStanding {
  signups: number;
  qualified: number;
  unlock: PartnerUnlock;
  earnedCents: number;
  lockedCents: number;
  availableCents: number;
  requestedCents: number;
  paidOutCents: number;
}

type ReferralRow = { creditedAt: Date | null; creditCents: number | null; reversedAt: Date | null };
type CashoutRow = { amountCents: number; status: string };

/** Everything a partner has, derived from their rows. */
export function standingFrom(
  referrals: readonly ReferralRow[],
  cashouts: readonly CashoutRow[],
  now: Date,
): PartnerStanding {
  const earned = referrals.filter(
    (r): r is ReferralRow & { creditedAt: Date } => r.creditedAt !== null && r.reversedAt === null,
  );
  const unlock = partnerUnlock(
    earned.map((r) => r.creditedAt),
    now,
  );
  const earnedCents = earned.reduce((s, r) => s + (r.creditCents ?? 0), 0);
  const requestedCents = cashouts
    .filter((c) => c.status === "REQUESTED")
    .reduce((s, c) => s + c.amountCents, 0);
  const paidOutCents = cashouts
    .filter((c) => c.status === "PAID")
    .reduce((s, c) => s + c.amountCents, 0);
  return {
    signups: referrals.length,
    qualified: earned.length,
    unlock,
    ...partnerBalance({
      earnedCents,
      cashedOutCents: requestedCents + paidOutCents,
      unlocked: unlock.unlocked,
    }),
    requestedCents,
    paidOutCents,
  };
}

const standingSelect = {
  referrals: { select: { creditedAt: true, creditCents: true, reversedAt: true } },
  cashouts: { select: { amountCents: true, status: true } },
} as const;

/** The signed-in person's partner page, or null when they aren't a partner. */
export async function partnerForUser(userId: string, now: Date = new Date()) {
  const partner = await runAsOwner((tx) =>
    tx.partner.findUnique({
      where: { userId },
      include: {
        ...standingSelect,
        cashouts: {
          select: { id: true, amountCents: true, status: true, requestedAt: true, paidAt: true },
          orderBy: { requestedAt: "desc" },
        },
      },
    }),
  );
  if (!partner) return null;
  return {
    name: partner.name,
    code: partner.code,
    active: partner.deactivatedAt === null,
    standing: standingFrom(partner.referrals, partner.cashouts, now),
    cashouts: partner.cashouts,
  };
}

export type CashoutError = PartnerCashoutRefusal | "not_a_partner" | "inactive";

/**
 * Ask to be paid. RACE-SAFE: the partner's row is locked FOR UPDATE before the
 * balance is read, so two requests at once run one after the other and the
 * second sees the first's cashout. Two $50 requests against $50 → one wins.
 */
export async function requestPartnerCashout(
  userId: string,
  amountCents: number,
  now: Date = new Date(),
): Promise<{ ok: true; cashoutId: string } | { ok: false; error: CashoutError }> {
  return runAsOwner(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; deactivatedAt: Date | null }[]>(
      Prisma.sql`SELECT "id", "deactivatedAt" FROM "Partner" WHERE "userId" = ${userId} FOR UPDATE`,
    );
    const row = locked[0];
    if (!row) return { ok: false, error: "not_a_partner" } as const;
    if (row.deactivatedAt) return { ok: false, error: "inactive" } as const;
    const partner = await tx.partner.findUniqueOrThrow({
      where: { id: row.id },
      select: standingSelect,
    });
    const standing = standingFrom(partner.referrals, partner.cashouts, now);
    const refusal = partnerCashoutRefusal({
      amountCents,
      unlocked: standing.unlock.unlocked,
      availableCents: standing.availableCents,
    });
    if (refusal) return { ok: false, error: refusal } as const;
    const cashout = await tx.partnerCashout.create({
      data: { partnerId: row.id, amountCents, requestedByUserId: userId, requestedAt: now },
      select: { id: true },
    });
    logger.info({ partnerId: row.id, amountCents }, "partner: cashout requested");
    return { ok: true, cashoutId: cashout.id } as const;
  });
}

/** An admin paid a cashout by hand. REQUESTED -> PAID, once. */
export async function markPartnerCashoutPaid(
  cashoutId: string,
  adminUserId: string,
  now: Date = new Date(),
): Promise<"ok" | "not_found" | "already_paid"> {
  return runAsOwner(async (tx) => {
    const { count } = await tx.partnerCashout.updateMany({
      where: { id: cashoutId, status: "REQUESTED" },
      data: { status: "PAID", paidAt: now, paidByUserId: adminUserId },
    });
    if (count > 0) return "ok";
    const exists = await tx.partnerCashout.findUnique({ where: { id: cashoutId }, select: { id: true } });
    return exists ? "already_paid" : "not_found";
  });
}

export type CreatePartnerError = "invalid_code" | "code_taken" | "no_such_user" | "user_taken";

/** An admin adds a partner. The code is unique ignoring case and spaces. */
export async function createPartner(params: {
  name: string;
  code: string;
  email?: string | null;
  adminUserId: string;
}): Promise<{ ok: true; partnerId: string } | { ok: false; error: CreatePartnerError }> {
  const codeKey = normalizePartnerCode(params.code);
  if (!codeKey) return { ok: false, error: "invalid_code" };
  let userId: string | null = null;
  if (params.email) {
    const user = await prisma.user.findUnique({
      where: { email: params.email.trim().toLowerCase() },
      select: { id: true },
    });
    if (!user) return { ok: false, error: "no_such_user" };
    userId = user.id;
  }
  try {
    const partner = await runAsOwner((tx) =>
      tx.partner.create({
        data: {
          name: params.name.trim(),
          code: params.code.trim().replace(/\s+/g, " "),
          codeKey,
          userId,
          createdByUserId: params.adminUserId,
        },
        select: { id: true },
      }),
    );
    return { ok: true, partnerId: partner.id };
  } catch (err) {
    // The unique indexes are the check: no read-then-insert race.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const target = String((err.meta as { target?: unknown } | undefined)?.target ?? "");
      return { ok: false, error: target.includes("userId") ? "user_taken" : "code_taken" };
    }
    throw err;
  }
}

/** Switch a partner off (their code stops working, cashouts are refused) or back on. */
export async function setPartnerActive(partnerId: string, active: boolean): Promise<boolean> {
  const { count } = await runAsOwner((tx) =>
    tx.partner.updateMany({
      where: { id: partnerId },
      data: { deactivatedAt: active ? null : new Date() },
    }),
  );
  return count > 0;
}

/** The admin table: every partner with their standing, and every unpaid cashout. */
export async function partnersForAdmin(now: Date = new Date()) {
  return runAsOwner(async (tx) => {
    const partners = await tx.partner.findMany({
      orderBy: { createdAt: "asc" },
      include: standingSelect,
    });
    const userIds = partners.map((p) => p.userId).filter((v): v is string => v !== null);
    const users = userIds.length
      ? await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
      : [];
    const emailOf = new Map(users.map((u) => [u.id, u.email]));
    const pending = await tx.partnerCashout.findMany({
      where: { status: "REQUESTED" },
      orderBy: { requestedAt: "asc" },
      select: { id: true, partnerId: true, amountCents: true, requestedAt: true },
    });
    const nameOf = new Map(partners.map((p) => [p.id, p.name]));
    return {
      partners: partners.map((p) => ({
        id: p.id,
        name: p.name,
        code: p.code,
        email: p.userId ? (emailOf.get(p.userId) ?? null) : null,
        active: p.deactivatedAt === null,
        createdAt: p.createdAt,
        standing: standingFrom(p.referrals, p.cashouts, now),
      })),
      pendingCashouts: pending.map((c) => ({ ...c, partnerName: nameOf.get(c.partnerId) ?? "" })),
    };
  });
}
