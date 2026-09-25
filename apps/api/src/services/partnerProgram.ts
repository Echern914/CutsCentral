import type Stripe from "stripe";
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
// Only used inside function bodies (billing/stripe.ts imports this module), so
// the import cycle never exists at module evaluation - the referral.ts pattern.
import { stripeClient } from "../billing/stripe.js";

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
 *     credited again. A credit note names the invoice; a refund (on API
 *     2025-03-31.basil and later) and a dispute (always) name only the
 *     PAYMENT, which is why the credit also records the invoice's payment
 *     intent.
 *  5. Cashout: the partner asks for $25 or $50 of an unlocked balance; an
 *     admin pays it by hand and marks it paid, or declines it. Nothing here
 *     moves money.
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

const idOf = (v: string | { id?: string } | null | undefined): string | null =>
  typeof v === "string" ? v : (v?.id ?? null);

/**
 * The PaymentIntent that paid this invoice, so a later refund or dispute -
 * which names only the payment - can find the reward it paid for. Older API
 * versions put it on the invoice; 2025-03-31.basil and later list it under
 * the invoice's payments, which the webhook payload doesn't include. Throws
 * when Stripe can't be asked: the webhook then 500s and Stripe redelivers,
 * rather than crediting a reward nothing could ever reverse.
 */
export async function paymentIntentForInvoice(invoice: Stripe.Invoice): Promise<string | null> {
  const legacy = idOf(
    (invoice as unknown as { payment_intent?: string | { id?: string } | null }).payment_intent,
  );
  if (legacy) return legacy;
  if (!invoice.id) return null;
  const payments = await stripeClient().invoicePayments.list({ invoice: invoice.id, limit: 10 });
  for (const p of payments.data) {
    if (p.status !== "paid" || p.payment?.type !== "payment_intent") continue;
    const pi = idOf(p.payment.payment_intent);
    if (pi) return pi;
  }
  return null;
}

/**
 * A paid invoice for this business: set the partner's one-time reward if the
 * plan qualifies and it hasn't been set yet. Idempotent by construction - the
 * update only matches a row whose creditedAt is still null - so Stripe
 * redelivering the event, or a later invoice, finds nothing to do.
 *
 * `paymentIntentId` is asked only when there is a reward to set, so ordinary
 * shops' invoices never cost a Stripe call.
 */
export async function creditPartnerReferral(params: {
  shopId: string;
  invoiceId: string;
  plan: string | null;
  amountPaidCents: number;
  paidAt: Date;
  paymentIntentId: () => Promise<string | null>;
}): Promise<boolean> {
  if (!partnerInvoiceQualifies(params.plan, params.amountPaidCents)) return false;
  const pending = await runAsOwner((tx) =>
    tx.partnerReferral.findFirst({
      where: { referredShopId: params.shopId, creditedAt: null },
      select: { id: true },
    }),
  );
  if (!pending) return false;
  const paymentIntentId = await params.paymentIntentId();
  const { count } = await runAsOwner((tx) =>
    tx.partnerReferral.updateMany({
      where: { id: pending.id, creditedAt: null },
      data: {
        creditedAt: params.paidAt,
        creditCents: PARTNER_PROGRAM.rewardCents,
        creditPlan: params.plan,
        creditInvoiceId: params.invoiceId,
        creditPaymentIntentId: paymentIntentId,
      },
    }),
  );
  if (count > 0) {
    logger.info({ shopId: params.shopId, plan: params.plan }, "partner: referral credited");
  }
  return count > 0;
}

export type PartnerReversalReason = "invoice_refunded" | "payment_disputed" | "credit_note";

/**
 * Money from the invoice that earned a reward went back: the reward goes too.
 * Once. Matched by the invoice (a credit note, or a refund on an older API
 * version) or by the payment that paid it (a refund on basil and later, and
 * every dispute).
 */
export async function reversePartnerCredit(
  match: { invoiceId: string | null; paymentIntentId: string | null },
  reason: PartnerReversalReason,
  now: Date = new Date(),
): Promise<boolean> {
  const or: Prisma.PartnerReferralWhereInput[] = [];
  if (match.invoiceId) or.push({ creditInvoiceId: match.invoiceId });
  if (match.paymentIntentId) or.push({ creditPaymentIntentId: match.paymentIntentId });
  if (or.length === 0) return false;
  const { count } = await runAsOwner((tx) =>
    tx.partnerReferral.updateMany({
      where: { OR: or, reversedAt: null },
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
type CashoutRow = { id?: string; amountCents: number; status: string };

/** Everything a partner has, derived from their rows. */
export function standingFrom(
  referrals: readonly ReferralRow[],
  cashouts: readonly CashoutRow[],
  now: Date,
): PartnerStanding {
  const earned = referrals.filter(
    (r): r is ReferralRow & { creditedAt: Date } => r.creditedAt !== null && r.reversedAt === null,
  );
  // Reversed rewards still anchor their window (they just don't count), so a
  // refund can only ever take an unlock away - see partnerUnlock.
  const reversed = referrals.filter(
    (r): r is ReferralRow & { creditedAt: Date } => r.creditedAt !== null && r.reversedAt !== null,
  );
  const unlock = partnerUnlock(
    earned.map((r) => r.creditedAt),
    now,
    reversed.map((r) => r.creditedAt),
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
  cashouts: { select: { id: true, amountCents: true, status: true } },
} as const;

export type CashoutUncovered = "inactive" | "locked" | "insufficient_balance";

/**
 * Would this pending cashout still be allowed if it were asked for now? Null
 * when yes. Its own amount is left out of the balance it is checked against,
 * so a request that was fine when made reads as covered until something -
 * a reversal, a pause - takes that away.
 */
function cashoutUncovered(
  partner: { deactivatedAt: Date | null; referrals: ReferralRow[]; cashouts: CashoutRow[] },
  cashout: { id: string; amountCents: number },
  now: Date,
): CashoutUncovered | null {
  if (partner.deactivatedAt) return "inactive";
  const standing = standingFrom(
    partner.referrals,
    partner.cashouts.filter((c) => c.id !== cashout.id),
    now,
  );
  if (!standing.unlock.unlocked) return "locked";
  if (cashout.amountCents > standing.availableCents) return "insufficient_balance";
  return null;
}

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

export type SettleCashoutResult =
  | { ok: true }
  | { ok: false; error: "not_found" | "already_settled" }
  | { ok: false; error: "not_covered"; reason: CashoutUncovered };

/**
 * Lock the cashout's partner, then settle a REQUESTED cashout exactly once.
 * The lock is the one requestPartnerCashout takes, so a settle and a new
 * request for the same partner run one after the other.
 */
async function settleCashout(
  cashoutId: string,
  settle: (
    tx: Prisma.TransactionClient,
    partner: { deactivatedAt: Date | null; referrals: ReferralRow[]; cashouts: CashoutRow[] },
    cashout: { id: string; amountCents: number },
  ) => Promise<SettleCashoutResult>,
): Promise<SettleCashoutResult> {
  return runAsOwner(async (tx) => {
    const found = await tx.partnerCashout.findUnique({
      where: { id: cashoutId },
      select: { id: true, partnerId: true, amountCents: true },
    });
    if (!found) return { ok: false, error: "not_found" } as const;
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Partner" WHERE "id" = ${found.partnerId} FOR UPDATE`);
    const partner = await tx.partner.findUniqueOrThrow({
      where: { id: found.partnerId },
      select: { deactivatedAt: true, ...standingSelect },
    });
    const current = partner.cashouts.find((c) => c.id === cashoutId);
    if (!current || current.status !== "REQUESTED") return { ok: false, error: "already_settled" } as const;
    return settle(tx, partner, found);
  });
}

/**
 * An admin paid a cashout by hand. REQUESTED -> PAID, once.
 *
 * Refused with `not_covered` when the request would not be allowed today - the
 * partner was paused, or rewards behind it were refunded or disputed after the
 * ask - unless the admin says `override` (they already sent the money and the
 * record must say so). The pending list shows the same check before paying.
 */
export async function markPartnerCashoutPaid(
  cashoutId: string,
  adminUserId: string,
  opts: { override?: boolean; now?: Date } = {},
): Promise<SettleCashoutResult> {
  const now = opts.now ?? new Date();
  return settleCashout(cashoutId, async (tx, partner, cashout) => {
    const uncovered = cashoutUncovered(partner, cashout, now);
    if (uncovered && !opts.override) return { ok: false, error: "not_covered", reason: uncovered };
    await tx.partnerCashout.update({
      where: { id: cashout.id },
      data: { status: "PAID", paidAt: now, paidByUserId: adminUserId },
    });
    logger.info({ cashoutId, override: Boolean(uncovered) }, "partner: cashout marked paid");
    return { ok: true };
  });
}

/**
 * An admin won't pay a request. REQUESTED -> DECLINED, once; the amount goes
 * back to the partner's balance (standing counts only REQUESTED and PAID).
 */
export async function declinePartnerCashout(
  cashoutId: string,
  adminUserId: string,
  now: Date = new Date(),
): Promise<SettleCashoutResult> {
  return settleCashout(cashoutId, async (tx, _partner, cashout) => {
    await tx.partnerCashout.update({
      where: { id: cashout.id },
      data: { status: "DECLINED", declinedAt: now, declinedByUserId: adminUserId },
    });
    logger.info({ cashoutId }, "partner: cashout declined");
    return { ok: true };
  });
}

export type CreatePartnerError = "invalid_code" | "code_taken" | "no_such_user" | "user_taken";

/**
 * An admin adds a partner. The code is unique ignoring case and spaces.
 *
 * The login is REQUIRED: the partner's own login is the only thing that can
 * ask for a cashout, and a cashout row is the only record that money was
 * paid. A partner without one could be paid by hand but never recorded, and
 * their balance would never go down.
 */
export async function createPartner(params: {
  name: string;
  code: string;
  email: string;
  adminUserId: string;
}): Promise<{ ok: true; partnerId: string } | { ok: false; error: CreatePartnerError }> {
  const codeKey = normalizePartnerCode(params.code);
  if (!codeKey) return { ok: false, error: "invalid_code" };
  const user = await prisma.user.findUnique({
    where: { email: params.email.trim().toLowerCase() },
    select: { id: true },
  });
  if (!user) return { ok: false, error: "no_such_user" };
  const userId = user.id;
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
    const byId = new Map(partners.map((p) => [p.id, p]));
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
      // Each request carries whether it is still covered, so the admin sees a
      // reversal or a pause BEFORE paying by hand - not after.
      pendingCashouts: pending.map((c) => {
        const p = byId.get(c.partnerId);
        return {
          ...c,
          partnerName: p?.name ?? "",
          uncovered: p ? cashoutUncovered(p, c, now) : ("inactive" as const),
        };
      }),
    };
  });
}
