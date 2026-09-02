import { Prisma, runAsOwner } from "@chairback/db";
import {
  AFFILIATE_DECISION_PUBLIC_COPY,
  AFFILIATE_POLICY,
  AFFILIATE_REVERSAL_PUBLIC_COPY,
  maskBusinessLabel,
  type AffiliateDecisionReason,
  type AffiliateReversalReason,
} from "@chairback/config";
import { emailDispatchMode, ResendSendError, sendEmail } from "../messaging/email.js";
import { buildAffiliateEmail } from "../messaging/affiliateEmails.js";
import { logger } from "../logger.js";
import {
  ambiguous,
  classifyRefusedReservation,
  definitiveFailure,
  PROVIDER_IDEMPOTENCY_WINDOW_MS,
  reserveAttempt,
  settle,
  type IntentOutcome,
} from "./appointmentCanceledNotify.js";

/**
 * The affiliate program's emails - approved, rejected, a month on the way,
 * a month ready, a month taken back - through the SAME durable outbox the
 * cancellation email uses (services/appointmentCanceledNotify.ts).
 *
 * The promise to email is written INSIDE the transaction that makes the
 * decision (`enqueueAffiliateEmail`), so it is exactly as durable as the
 * decision and can neither precede it nor outlive its rollback. The outbox
 * worker delivers later with the write-ahead / idempotency-key state machine
 * this file borrows wholesale rather than re-deriving.
 *
 * WHAT THE INTENT ROW CARRIES. EmailIntent has no generic subject column
 * (it was built for appointments), so the subject rides in the idempotency
 * key: `affiliate:application:<id>:approved`, `affiliate:reward:<id>:available`.
 * Durable, unique per event, and the parse is the only coupling.
 *
 * WHO IT GOES TO. The affiliate's shop OWNER, by the address on their user
 * record - the same person who signed up. Never a referred business.
 *
 * 🔴 No SMS. Ever. The program's contract forbids it; this file has no path
 * to it.
 */

export const AFFILIATE_EMAIL_KINDS = [
  "affiliate_approved",
  "affiliate_rejected",
  "affiliate_reward_qualified",
  "affiliate_reward_available",
  "affiliate_reward_reversed",
] as const;
export type AffiliateEmailKind = (typeof AFFILIATE_EMAIL_KINDS)[number];

const KINDS = new Set<string>(AFFILIATE_EMAIL_KINDS);

export function isAffiliateEmailKind(kind: string): kind is AffiliateEmailKind {
  return KINDS.has(kind);
}

type Subject = "application" | "reward";

const KIND_SUBJECT: Record<AffiliateEmailKind, { subject: Subject; event: string }> = {
  affiliate_approved: { subject: "application", event: "approved" },
  affiliate_rejected: { subject: "application", event: "rejected" },
  affiliate_reward_qualified: { subject: "reward", event: "qualified" },
  affiliate_reward_available: { subject: "reward", event: "available" },
  affiliate_reward_reversed: { subject: "reward", event: "reversed" },
};

/** One key per (subject, event) - a replay of the same decision is a no-op. */
export function affiliateEmailKey(kind: AffiliateEmailKind, subjectId: string): string {
  const { subject, event } = KIND_SUBJECT[kind];
  return `affiliate:${subject}:${subjectId}:${event}`;
}

function parseKey(key: string): { subject: Subject; id: string; event: string } | null {
  const m = /^affiliate:(application|reward):([A-Za-z0-9_-]+):([a-z_]+)$/.exec(key);
  if (!m) return null;
  return { subject: m[1] as Subject, id: m[2]!, event: m[3]! };
}

/**
 * Enqueue, inside the caller's transaction. Returns the key, or null when
 * the affiliate could not be resolved (nothing to send, nothing recorded).
 * `skipDuplicates` + the UNIQUE key make a CAS retry a no-op.
 */
export async function enqueueAffiliateEmail(
  tx: Prisma.TransactionClient,
  params: {
    kind: AffiliateEmailKind;
    subjectId: string;
    /** Either the affiliate's shop id, or their account id to resolve it from. */
    affiliateShopId?: string;
    affiliateAccountId?: string | null;
  },
): Promise<string | null> {
  let shopId = params.affiliateShopId ?? null;
  if (!shopId && params.affiliateAccountId) {
    const account = await tx.affiliateAccount.findUnique({
      where: { id: params.affiliateAccountId },
      select: { shopId: true },
    });
    shopId = account?.shopId ?? null;
  }
  if (!shopId) return null;
  const idempotencyKey = affiliateEmailKey(params.kind, params.subjectId);
  await tx.emailIntent.createMany({
    data: [
      {
        kind: params.kind,
        idempotencyKey,
        shopId,
        status: "PENDING",
        nextAttemptAt: new Date(0),
      },
    ],
    skipDuplicates: true,
  });
  return idempotencyKey;
}

/** Rewards for which each event's email is still TRUE right now. */
const STILL_TRUE: Record<string, ReadonlySet<string>> = {
  qualified: new Set(["PENDING", "REVIEW_REQUIRED", "AVAILABLE", "RESERVED", "APPLIED"]),
  available: new Set(["AVAILABLE", "RESERVED", "APPLIED"]),
  reversed: new Set(["REVERSED"]),
};

interface Resolved {
  to: string | null;
  shopName: string;
  code?: string;
  publicMessage?: string;
  canReapply?: boolean;
  label?: string;
  holdEndsAt?: Date | null;
  expiresAt?: Date | null;
  reversalMessage?: string;
}

/**
 * Deliver one claimed affiliate intent. Same contract as
 * deliverCancellationIntent: never throws, classifies every ending.
 */
export async function deliverAffiliateIntent(params: {
  intentId: string;
  claimToken: string;
  now?: Date;
}): Promise<IntentOutcome> {
  const now = params.now ?? new Date();
  const intent = await runAsOwner((tx) =>
    tx.emailIntent.findUnique({ where: { id: params.intentId } }),
  );
  if (!intent || !isAffiliateEmailKind(intent.kind)) return "not_found";
  const kind = intent.kind;
  const parsed = parseKey(intent.idempotencyKey);
  if (!parsed || parsed.subject !== KIND_SUBJECT[kind].subject) {
    await settle(params.intentId, "FAILED", "bad_key");
    return "skipped";
  }

  // 🔴 Is the thing this email says still true? A decision can move on
  // between the enqueue and the send (a reward reversed the day after it
  // became available). Stale news is superseded, not sent.
  const resolved = await runAsOwner(async (tx): Promise<Resolved | null> => {
    const shop = await tx.shop.findUnique({
      where: { id: intent.shopId },
      select: { name: true, owner: { select: { email: true } } },
    });
    if (!shop) return null;
    const base: Resolved = { to: shop.owner.email ?? null, shopName: shop.name };

    if (parsed.subject === "application") {
      const app = await tx.affiliateApplication.findUnique({
        where: { id: parsed.id },
        select: { status: true, decisionReason: true, shopId: true },
      });
      if (!app || app.shopId !== intent.shopId) return null;
      if (parsed.event === "approved") {
        if (app.status !== "APPROVED") return null;
        const account = await tx.affiliateAccount.findUnique({
          where: { applicationId: parsed.id },
          select: { code: true },
        });
        if (!account) return null;
        return { ...base, code: account.code };
      }
      if (app.status !== "REJECTED") return null;
      const reason = (app.decisionReason ?? "other") as AffiliateDecisionReason;
      return {
        ...base,
        publicMessage:
          AFFILIATE_DECISION_PUBLIC_COPY[reason] ?? AFFILIATE_DECISION_PUBLIC_COPY.other,
        canReapply: reason === "incomplete_application" || reason === "not_eligible",
      };
    }

    const reward = await tx.affiliateReward.findUnique({
      where: { id: parsed.id },
      select: {
        status: true,
        referredShopId: true,
        holdEndsAt: true,
        expiresAt: true,
        reversalReason: true,
        affiliateAccountId: true,
      },
    });
    if (!reward) return null;
    const account = await tx.affiliateAccount.findUnique({
      where: { id: reward.affiliateAccountId },
      select: { shopId: true },
    });
    if (account?.shopId !== intent.shopId) return null;
    if (!STILL_TRUE[parsed.event]?.has(reward.status)) return null;
    return {
      ...base,
      label: maskBusinessLabel(reward.referredShopId),
      holdEndsAt: reward.holdEndsAt,
      expiresAt: reward.expiresAt,
      reversalMessage:
        AFFILIATE_REVERSAL_PUBLIC_COPY[reward.reversalReason as AffiliateReversalReason] ??
        AFFILIATE_REVERSAL_PUBLIC_COPY.admin_adjustment,
    };
  });
  if (!resolved) {
    await settle(params.intentId, "SUPERSEDED", "superseded");
    return "superseded";
  }

  // The expired-ambiguous guard, before anything that could dispatch - see
  // deliverCancellationIntent for the full reasoning.
  const expired = await runAsOwner((tx) =>
    tx.emailIntent.updateMany({
      where: {
        id: params.intentId,
        status: "PENDING",
        claimToken: params.claimToken,
        lastAttemptAmbiguous: true,
        firstProviderAttemptAt: {
          lte: new Date(now.getTime() - PROVIDER_IDEMPOTENCY_WINDOW_MS),
        },
      },
      data: {
        status: "ABANDONED",
        lastError: "idempotency_window_expired",
        claimedAt: null,
        claimToken: null,
        nextAttemptAt: null,
      },
    }),
  );
  if (expired.count > 0) {
    logger.error(
      { intentId: params.intentId, reason: "idempotency_window_expired" },
      "affiliate email abandoned unsent - an earlier attempt may already have been delivered",
    );
    return "abandoned";
  }

  if (!resolved.to) {
    await settle(params.intentId, "FAILED", "no_address");
    return "skipped";
  }
  const mode = emailDispatchMode();
  if (mode !== "live") {
    await settle(params.intentId, "SUPPRESSED", mode);
    return "suppressed";
  }

  const email = buildAffiliateEmail(kind, {
    shopName: resolved.shopName,
    code: resolved.code,
    publicMessage: resolved.publicMessage,
    canReapply: resolved.canReapply,
    label: resolved.label,
    holdEndsAt: resolved.holdEndsAt ?? null,
    expiresAt: resolved.expiresAt ?? null,
    reversalMessage: resolved.reversalMessage,
    holdDays: AFFILIATE_POLICY.qualification.holdDaysAfterSecond,
  });

  const attemptNo = await reserveAttempt(params.intentId, params.claimToken, now);
  if (attemptNo === null) return await classifyRefusedReservation(params, now);

  try {
    const result = await sendEmail({
      to: resolved.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      stream: "transactional",
      idempotencyKey: intent.idempotencyKey,
      meta: { shopId: intent.shopId, kind: "affiliate" },
    });
    if (result.status !== "sent" || !result.id || result.id === "unknown") {
      return ambiguous(params.intentId, attemptNo, now, "no_message_id");
    }
    await runAsOwner(async (tx) => {
      await tx.emailIntent.update({
        where: { id: params.intentId },
        data: {
          status: "SENT",
          sentAt: now,
          messageId: result.id,
          claimedAt: null,
          claimToken: null,
          nextAttemptAt: null,
          lastError: null,
          lastAttemptAmbiguous: false,
        },
      });
      await tx.emailDelivery.upsert({
        where: { messageId: result.id },
        create: { messageId: result.id, kind: "affiliate", shopId: intent.shopId, status: "sent" },
        update: { kind: "affiliate", shopId: intent.shopId, awaitingDispatchMeta: false },
      });
    });
    return "sent";
  } catch (err) {
    if (err instanceof ResendSendError) {
      return definitiveFailure(params.intentId, attemptNo, err.classification, now);
    }
    return ambiguous(params.intentId, attemptNo, now, "transport_error");
  }
}
