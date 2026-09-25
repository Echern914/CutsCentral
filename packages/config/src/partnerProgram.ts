import { PAID_PLAN_KEYS, PLANS, type PaidPlanKey } from "./constants.js";

/**
 * The PARTNER program: cash for people who bring businesses to ChairBack.
 *
 * Drick's proposal, and the reason it is a third program rather than a
 * setting on one of the other two:
 *  - the legacy referral program (services/referral.ts) pays a SHOP a free
 *    month for referring another shop;
 *  - the affiliate program (affiliateProgram.ts) is a shop that applied, with a
 *    random code, earning subscription credit - "never cash" is in its terms;
 *  - a partner is a PERSON (Eric, a barber coach) with a code they can say out
 *    loud ("ERIC C"), created by a platform admin, earning a one-time cash
 *    amount per business, paid out BY HAND when they ask for it.
 *
 * Every number below is Eric's policy, in one place.
 */
export const PARTNER_PROGRAM = {
  /** Paid ONCE per referred business, when it first pays for a qualifying plan. */
  rewardCents: 500,
  /**
   * A plan qualifies when ChairBack keeps at least this much of one month of
   * it. $8 so that after the $5 reward ChairBack still keeps $3 of that month.
   */
  minPlanMarginCents: 800,
  unlock: {
    /** Qualifying referrals needed to unlock cashout... */
    referrals: 5,
    /** ...within this many days of the window's first one. */
    windowDays: 90,
  },
  /** The only amounts a partner may ask to be paid. */
  cashoutAmountsCents: [2500, 5000] as readonly number[],
} as const;

/**
 * Stripe's standard card fee for a US card: what ChairBack loses off the top
 * of every subscription payment. It is the only per-month cost this file
 * knows, so it is the only one "margin" subtracts - texting, hosting and
 * support costs are not modeled anywhere in the codebase.
 */
export const STRIPE_CARD_FEE = { rate: 0.029, fixedCents: 30 } as const;

/** What ChairBack keeps of one payment of `cents`, after Stripe's card fee. */
export function planMarginCents(cents: number): number {
  return Math.floor(cents - cents * STRIPE_CARD_FEE.rate - STRIPE_CARD_FEE.fixedCents);
}

function priceCents(plan: PaidPlanKey): number {
  return Math.round(PLANS[plan].priceMonthlyUsd * 100);
}

/**
 * The plans whose month earns a partner their reward, DERIVED from the plan
 * table: add or reprice a plan in PLANS and this follows. Today every paid
 * plan qualifies (Starter keeps ~$19.12 of $20).
 */
export const PARTNER_QUALIFYING_PLANS: readonly PaidPlanKey[] = PAID_PLAN_KEYS.filter(
  (k) => planMarginCents(priceCents(k)) >= PARTNER_PROGRAM.minPlanMarginCents,
);

/**
 * Does this paid invoice earn the referring partner their reward?
 *
 * The plan must qualify AND the money actually paid (before tax - the caller
 * takes tax off, since tax is never ChairBack's) must clear the margin: a shop
 * on a heavy coupon is on a qualifying plan but did not pay for it, so it does
 * not qualify THIS month (a later full-price month still will).
 */
export function partnerInvoiceQualifies(
  plan: string | null | undefined,
  amountPaidCents: number,
): boolean {
  if (!plan || !(PARTNER_QUALIFYING_PLANS as readonly string[]).includes(plan)) return false;
  return amountPaidCents > 0 && planMarginCents(amountPaidCents) >= PARTNER_PROGRAM.minPlanMarginCents;
}

/**
 * A partner code as the program compares it: case and spaces don't matter,
 * so "eric c", "Eric C" and "ERICC" are all "ERIC C". Returns null for
 * anything that can't be a code (empty, too long, or not letters/digits once
 * the spaces are gone).
 */
export function normalizePartnerCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.replace(/\s+/g, "").toUpperCase();
  if (!key || key.length > 32) return null;
  return /^[A-Z0-9_-]+$/.test(key) ? key : null;
}

const DAY_MS = 86_400_000;

export interface PartnerUnlockWindow {
  /** The qualifying referral that opened this window. */
  opensAt: Date;
  /** The last instant a referral still counts toward this window. */
  closesAt: Date;
  /** Qualifying referrals inside this window so far. */
  count: number;
  /** false once `now` is past closesAt: the next referral opens a new window. */
  open: boolean;
}

export interface PartnerUnlock {
  unlocked: boolean;
  /** The referral that completed the window. Later gaps never relock. */
  unlockedAt: Date | null;
  /** The window being counted (or the last one that lapsed). Null before the
   *  first qualifying referral, and once unlocked. */
  window: PartnerUnlockWindow | null;
}

/**
 * 🔴 THE CASHOUT UNLOCK POLICY - the one place it lives.
 *
 * Drick: "Eric must sign up 5 people in a 90 days span from the first signup
 * in order to receive cashout."
 *
 * As implemented:
 *  - A window opens at the partner's FIRST qualifying referral and runs
 *    90 days, inclusive: a referral exactly 90 days later still counts, one a
 *    millisecond past does not.
 *  - 5 qualifying referrals inside one window unlock cashout for good. (The
 *    caller passes only rewards that still stand, so a refund that takes back
 *    one of the five that did it takes the unlock back with it.)
 *  - A window that closes short does not reset anything: the next qualifying
 *    referral opens a NEW window, counting from 1. Nothing earned is lost -
 *    earnings from a lapsed window stay locked, and are released with
 *    everything else the moment cashout unlocks.
 *
 * Pure: `qualifiedAt` is every qualifying referral's instant (any order),
 * `now` only decides whether the last window is still open.
 */
export function partnerUnlock(qualifiedAt: readonly Date[], now: Date): PartnerUnlock {
  const { referrals, windowDays } = PARTNER_PROGRAM.unlock;
  const spanMs = windowDays * DAY_MS;
  const sorted = [...qualifiedAt].sort((a, b) => a.getTime() - b.getTime());
  let opensAt: Date | null = null;
  let count = 0;
  for (const at of sorted) {
    if (opensAt === null || at.getTime() - opensAt.getTime() > spanMs) {
      opensAt = at;
      count = 1;
    } else {
      count += 1;
    }
    if (count >= referrals) return { unlocked: true, unlockedAt: at, window: null };
  }
  if (opensAt === null) return { unlocked: false, unlockedAt: null, window: null };
  const closesAt = new Date(opensAt.getTime() + spanMs);
  return {
    unlocked: false,
    unlockedAt: null,
    window: { opensAt, closesAt, count, open: now.getTime() <= closesAt.getTime() },
  };
}

/**
 * What a partner has, in cents. Everything they earned is theirs; it is only
 * AVAILABLE to cash out once unlocked. Cashouts already asked for (paid or
 * not) come off the available amount so the same money can't be asked twice.
 */
export function partnerBalance(input: {
  earnedCents: number;
  cashedOutCents: number;
  unlocked: boolean;
}): { earnedCents: number; lockedCents: number; availableCents: number } {
  const remaining = Math.max(0, input.earnedCents - input.cashedOutCents);
  return {
    earnedCents: input.earnedCents,
    lockedCents: input.unlocked ? 0 : remaining,
    availableCents: input.unlocked ? remaining : 0,
  };
}

export type PartnerCashoutRefusal = "invalid_amount" | "locked" | "insufficient_balance";

/** Why a cashout of `amountCents` can't be asked for now, or null when it can. */
export function partnerCashoutRefusal(input: {
  amountCents: number;
  unlocked: boolean;
  availableCents: number;
}): PartnerCashoutRefusal | null {
  if (!PARTNER_PROGRAM.cashoutAmountsCents.includes(input.amountCents)) return "invalid_amount";
  if (!input.unlocked) return "locked";
  if (input.amountCents > input.availableCents) return "insufficient_balance";
  return null;
}

/** What the signup form says when a typed referral code can't be used. */
export const PARTNER_CODE_ERROR_COPY: Record<string, string> = {
  unknown_referral_code:
    "We don't recognize that referral code. Check the spelling, or clear the field to continue without one.",
  inactive_referral_code:
    "That referral code is no longer active. Clear the field to continue without one.",
  own_referral_code:
    "That's your own referral code, so it can't be used for your business. Clear the field to continue.",
};
