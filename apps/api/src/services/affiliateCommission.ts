import { Prisma, runAsOwner } from "@chairback/db";
import {
  AFFILIATE_POLICY,
  apiEnv,
  commissionCents,
  commissionRateBps,
  commissionWindowEnd,
  type AffiliatePayoutPreference,
} from "@chairback/config";
import { recordAffiliateEvent } from "./affiliateAudit.js";

/**
 * The v2 affiliate COMMISSION LEDGER (PR 1 of 3).
 *
 * For every base-plan invoice a referred business pays in its first
 * AFFILIATE_POLICY.commission.months months, the affiliate earns one line:
 * cashBps of the base-plan amount if they chose cash, creditBps if they chose
 * ChairBack bill credit. The choice is FROZEN onto the line at earn time.
 *
 * 🔴 NOTHING HERE MOVES MONEY AND NOTHING HERE TALKS TO STRIPE. It only reads
 * events Stripe already delivered (via affiliateQualification.ts) and writes
 * our own rows. Paying cash (Stripe Express) and applying bill credit are
 * later phases that read AVAILABLE lines and fill `payoutId`. A refund that
 * arrives after a line was PAID is RECORDED (`clawbackDueAt`), never collected
 * here.
 *
 * THE RULES (every number from AFFILIATE_POLICY, none invented here)
 *  - One line per Stripe INVOICE - a unique index, not a check. Redelivered
 *    events and a second event id about the same invoice earn once.
 *  - Only invoices paid strictly before commissionWindowEnd(first paid base
 *    invoice) earn.
 *  - A line is HELD for `holdDays`, and becomes AVAILABLE only once that has
 *    passed AND the business has paid `qualification.qualifyingInvoices`
 *    base-plan invoices that were not refunded/disputed/credited back.
 *  - A line for a non-ACTIVE affiliate is REVIEW_REQUIRED - held for a person,
 *    never silently dropped and never released by the sweep.
 */

const DAY_MS = 86_400_000;

/** Statuses a refund/dispute/credit note may still reverse outright. */
const REVERSIBLE = ["HELD", "AVAILABLE", "REVIEW_REQUIRED"] as const;

export type CommissionReversalReason =
  | "invoice_refunded"
  | "payment_disputed"
  | "credit_note"
  | "admin_adjustment";

/** The commission ledger's own switch, layered on the qualification flags. */
export function commissionsEnabled(): boolean {
  const env = apiEnv();
  return (
    env.AFFILIATE_PROGRAM_ENABLED &&
    env.AFFILIATE_QUALIFICATION_ENABLED &&
    env.AFFILIATE_COMMISSIONS_ENABLED
  );
}

function asKind(pref: string): AffiliatePayoutPreference {
  // The column is CHECK-pinned to these two; anything else cannot be read.
  return pref === "cash" ? "cash" : "credit";
}

export interface EarnCommissionInput {
  stripeInvoiceId: string;
  referredShopId: string;
  affiliateAccountId: string;
  /** Base-plan cents actually paid on this invoice (tax/add-ons excluded). */
  basisCents: number;
  currency: string;
  /** The invoice's paid_at. */
  paidAt: Date;
}

/**
 * Write the commission line for one paid base-plan invoice, inside the
 * qualification transaction. The caller has already recorded the invoice's
 * AffiliateQualifyingInvoice row, so the "first paid invoice" read below
 * includes this one.
 *
 * Returns the status written, or null when this invoice earns nothing (or
 * already earned).
 */
export async function earnCommissionForInvoice(
  tx: Prisma.TransactionClient,
  input: EarnCommissionInput,
): Promise<"HELD" | "REVIEW_REQUIRED" | null> {
  if (input.basisCents <= 0) return null;

  const account = await tx.affiliateAccount.findUnique({
    where: { id: input.affiliateAccountId },
    select: { id: true, status: true, payoutPreference: true },
  });
  if (!account) return null;

  // The 12-month window runs from the business's FIRST paid base invoice.
  const first = await tx.affiliateQualifyingInvoice.aggregate({
    where: { referredShopId: input.referredShopId },
    _min: { paidAt: true },
  });
  const firstPaidAt = first._min.paidAt ?? input.paidAt;
  if (input.paidAt.getTime() >= commissionWindowEnd(firstPaidAt).getTime()) {
    return null;
  }

  // Frozen at earn time: a later change of preference never rewrites this.
  const kind = asKind(account.payoutPreference);
  const rateBps = commissionRateBps(kind);
  const amountCents = commissionCents(input.basisCents, kind);
  if (amountCents <= 0) return null;

  const status = account.status === "ACTIVE" ? "HELD" : "REVIEW_REQUIRED";

  const { count } = await tx.affiliateCommission.createMany({
    data: [
      {
        affiliateAccountId: account.id,
        referredShopId: input.referredShopId,
        stripeInvoiceId: input.stripeInvoiceId,
        baseAmountCents: input.basisCents,
        rateBps,
        amountCents,
        currency: input.currency,
        kind,
        status,
        earnedAt: input.paidAt,
        holdEndsAt: new Date(
          input.paidAt.getTime() + AFFILIATE_POLICY.commission.holdDays * DAY_MS,
        ),
      },
    ],
    // One line per invoice, ever. createMany + skipDuplicates rather than
    // create + catch: a P2002 caught in JavaScript does not un-abort the
    // surrounding Postgres transaction. count === 0 IS "already earned".
    skipDuplicates: true,
  });
  if (count === 0) return null;

  await recordAffiliateEvent(tx, {
    shopId: input.referredShopId,
    accountId: account.id,
    type: status === "HELD" ? "commission.earned" : "commission.review_flagged",
    actor: { type: "system" },
    metadata: { toStatus: status, commissionKind: kind, rateBps, amountCents },
  });
  return status;
}

/**
 * A refund, dispute or credit note against an invoice that earned a line.
 *
 * Not yet paid: CAS straight to REVERSED. Already PAID: the money has left, so
 * this only RECORDS that a clawback is due (once - the first reason wins); the
 * payout phase nets it from the next payout. Nothing here touches money.
 *
 * Runs whether or not AFFILIATE_COMMISSIONS_ENABLED is on: switching earning
 * off must never leave a refunded line standing.
 */
export async function reverseCommissionForInvoice(
  tx: Prisma.TransactionClient,
  stripeInvoiceId: string,
  reason: CommissionReversalReason,
  now: Date,
): Promise<"REVERSED" | "CLAWBACK_DUE" | null> {
  // The IN-list is the guard, deliberately not "the status I just read": the
  // hold sweep may move HELD -> AVAILABLE between a read and this write, and a
  // CAS on the read value would then miss and leave a refunded line standing.
  const reversed = await tx.affiliateCommission.updateMany({
    where: { stripeInvoiceId, status: { in: [...REVERSIBLE] } },
    data: { status: "REVERSED", reversedAt: now, reversalReason: reason },
  });
  if (reversed.count > 0) {
    const line = await tx.affiliateCommission.findUnique({
      where: { stripeInvoiceId },
      select: { referredShopId: true, affiliateAccountId: true },
    });
    if (line) {
      await recordAffiliateEvent(tx, {
        shopId: line.referredShopId,
        accountId: line.affiliateAccountId,
        type: "commission.reversed",
        actor: { type: "system" },
        metadata: { toStatus: "REVERSED", reversalReason: reason },
      });
    }
    return "REVERSED";
  }

  // Already paid out: mark it, once. Status stays PAID - the payout record
  // is evidence of what really happened and is never rewritten.
  const clawback = await tx.affiliateCommission.updateMany({
    where: { stripeInvoiceId, status: "PAID", clawbackDueAt: null },
    data: { clawbackDueAt: now, reversalReason: reason },
  });
  if (clawback.count > 0) {
    const line = await tx.affiliateCommission.findUnique({
      where: { stripeInvoiceId },
      select: { referredShopId: true, affiliateAccountId: true },
    });
    if (line) {
      await recordAffiliateEvent(tx, {
        shopId: line.referredShopId,
        accountId: line.affiliateAccountId,
        type: "commission.clawback_due",
        actor: { type: "system" },
        metadata: { fromStatus: "PAID", toStatus: "PAID", reversalReason: reason },
      });
    }
    return "CLAWBACK_DUE";
  }
  return null;
}

interface DueLine {
  id: string;
  referredShopId: string;
  affiliateAccountId: string;
  accountStatus: string | null;
}

/**
 * The hold sweep: HELD lines whose hold has passed AND whose business has paid
 * enough base-plan invoices become AVAILABLE.
 *
 * "Paid" means NOT taken back: an invoice whose own line was reversed, or
 * whose paid line has a clawback due, does not count toward the minimum - a
 * business that paid twice and refunded once has paid once.
 *
 * A line whose affiliate is no longer ACTIVE is moved to REVIEW_REQUIRED
 * instead of AVAILABLE: a suspension for suspected abuse must not let money
 * become payable while nobody is looking.
 *
 * Off (the default) means DRY RUN - it reports what it WOULD release and
 * writes nothing, so the numbers watched before enabling are the numbers you
 * get. Sends nothing either way.
 */
export async function releaseAffiliateCommissionHolds(opts?: {
  dryRun?: boolean;
  nowMs?: number;
}): Promise<{
  due: number;
  eligible: number;
  released: number;
  flagged: number;
  dryRun: boolean;
}> {
  const dryRun = opts?.dryRun ?? !commissionsEnabled();
  const now = new Date(opts?.nowMs ?? Date.now());
  // 🔴 Never a JS Date into $queryRaw (it is sent as timestamptz and shifted
  // by the session zone) - an ISO string cast to the column's own type.
  const nowIso = now.toISOString();
  const minimum = AFFILIATE_POLICY.qualification.qualifyingInvoices;

  return runAsOwner(async (tx) => {
    const due = await tx.affiliateCommission.count({
      where: { status: "HELD", holdEndsAt: { lte: now } },
    });
    if (due === 0) {
      return { due: 0, eligible: 0, released: 0, flagged: 0, dryRun };
    }

    // The invoice minimum is filtered IN SQL, so lines still waiting on a
    // second invoice can never fill the batch and starve lines that are ready.
    const lines = await tx.$queryRaw<DueLine[]>(Prisma.sql`
      SELECT c."id", c."referredShopId", c."affiliateAccountId",
             a."status" AS "accountStatus"
        FROM "AffiliateCommission" c
        LEFT JOIN "AffiliateAccount" a ON a."id" = c."affiliateAccountId"
       WHERE c."status" = 'HELD'
         AND c."holdEndsAt" <= ${nowIso}::timestamp
         AND (
           SELECT count(*)
             FROM "AffiliateQualifyingInvoice" q
            WHERE q."referredShopId" = c."referredShopId"
              AND NOT EXISTS (
                SELECT 1 FROM "AffiliateCommission" r
                 WHERE r."stripeInvoiceId" = q."stripeInvoiceId"
                   AND (r."status" = 'REVERSED' OR r."clawbackDueAt" IS NOT NULL)
              )
         ) >= ${minimum}
       ORDER BY c."holdEndsAt" ASC
       LIMIT 200
    `);

    if (dryRun || lines.length === 0) {
      return { due, eligible: lines.length, released: 0, flagged: 0, dryRun };
    }

    let released = 0;
    let flagged = 0;
    for (const line of lines) {
      const active = line.accountStatus === "ACTIVE";
      const toStatus = active ? "AVAILABLE" : "REVIEW_REQUIRED";
      // CAS per line: a second worker, or a refund that landed meanwhile,
      // finds count 0 and the line is left as that other writer decided.
      const { count } = await tx.affiliateCommission.updateMany({
        where: { id: line.id, status: "HELD" },
        data: active ? { status: "AVAILABLE", availableAt: now } : { status: "REVIEW_REQUIRED" },
      });
      if (count === 0) continue;
      if (active) released += 1;
      else flagged += 1;
      await recordAffiliateEvent(tx, {
        shopId: line.referredShopId,
        accountId: line.affiliateAccountId,
        type: active ? "commission.available" : "commission.review_flagged",
        actor: { type: "system" },
        metadata: { fromStatus: "HELD", toStatus },
      });
    }
    return { due, eligible: lines.length, released, flagged, dryRun };
  });
}

/** Cents in each state for one payout kind. */
export interface CommissionBucket {
  heldCents: number;
  availableCents: number;
  reviewCents: number;
  paidCents: number;
  reversedCents: number;
  /** PAID lines a later refund/dispute marked for clawback (a subset of paidCents). */
  clawbackDueCents: number;
}

export interface AffiliateEarnings {
  cash: CommissionBucket;
  credit: CommissionBucket;
  /** Distinct referred businesses with at least one line not reversed. */
  businessesEarning: number;
  /** The payout threshold the cash bucket is measured against. */
  minimumCashPayoutCents: number;
}

function emptyBucket(): CommissionBucket {
  return {
    heldCents: 0,
    availableCents: 0,
    reviewCents: 0,
    paidCents: 0,
    reversedCents: 0,
    clawbackDueCents: 0,
  };
}

/**
 * The read model the payout and UI phases build on: one affiliate's commission
 * totals, in integer cents, by kind and status. Reads the ledger only - never
 * a derived balance stored anywhere else.
 */
export async function getAffiliateEarnings(
  affiliateAccountId: string,
): Promise<AffiliateEarnings> {
  return runAsOwner(async (tx) => {
    const byState = await tx.affiliateCommission.groupBy({
      by: ["kind", "status"],
      where: { affiliateAccountId },
      _sum: { amountCents: true },
    });
    const clawbacks = await tx.affiliateCommission.groupBy({
      by: ["kind"],
      where: { affiliateAccountId, status: "PAID", clawbackDueAt: { not: null } },
      _sum: { amountCents: true },
    });
    const businesses = await tx.affiliateCommission.groupBy({
      by: ["referredShopId"],
      where: { affiliateAccountId, status: { not: "REVERSED" } },
    });

    const out: AffiliateEarnings = {
      cash: emptyBucket(),
      credit: emptyBucket(),
      businessesEarning: businesses.length,
      minimumCashPayoutCents: AFFILIATE_POLICY.commission.minimumCashPayoutCents,
    };
    for (const row of byState) {
      const bucket = out[asKind(row.kind)];
      const cents = row._sum.amountCents ?? 0;
      switch (row.status) {
        case "HELD":
          bucket.heldCents += cents;
          break;
        case "AVAILABLE":
          bucket.availableCents += cents;
          break;
        case "REVIEW_REQUIRED":
          bucket.reviewCents += cents;
          break;
        case "PAID":
          bucket.paidCents += cents;
          break;
        case "REVERSED":
          bucket.reversedCents += cents;
          break;
        default:
          break;
      }
    }
    for (const row of clawbacks) {
      out[asKind(row.kind)].clawbackDueCents += row._sum.amountCents ?? 0;
    }
    return out;
  });
}
