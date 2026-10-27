/**
 * The Affiliate Program's business contract, as ONE versioned object.
 *
 * This is the NEW program (applications, immutable rewards, Stripe credit) -
 * not the legacy referral program in services/referral.ts, which keeps its own
 * REFERRAL constants until it is frozen in the attribution phase.
 *
 * 🔴 NO PRICES LIVE HERE. The credit is "one month of the referrer's own base
 * subscription", snapshotted as money+currency from their REAL Stripe
 * subscription at qualification time. A price written down in this file would
 * drift from Stripe the first time a plan changes.
 *
 * Every number in AFFILIATE_POLICY is program POLICY, not a tuning knob: a
 * change here changes what affiliates were promised, so bump
 * AFFILIATE_POLICY_VERSION with it - accounts record the version they were
 * approved under.
 */
import { PLANS } from "./constants.js";

/** The affiliate terms document version an applicant accepts. Never edit the
 *  terms text in place - add a version, exactly like the SMS consent rule.
 *  v1: one month off per qualified business (kept at /affiliate-terms/v1).
 *  v2 (2026-10): the commission program - cash or bill credit. */
export const AFFILIATE_TERMS_VERSION = "v2";

/** Bump when any business rule below changes.
 *  v2 (2026-10): the commission program - a percentage of every base-plan
 *  invoice in a referred business's first 12 months, cash or bill credit -
 *  replaces the one-free-month reward for NEW qualifications. Accounts keep
 *  the version they were approved under; rewards already earned under v1 are
 *  honoured unchanged. */
export const AFFILIATE_POLICY_VERSION = 2;

export const AFFILIATE_POLICY = {
  version: AFFILIATE_POLICY_VERSION,
  attribution: {
    /** Days a captured referral cookie stays alive before signup. */
    windowDays: 60,
    /** Attribution becomes immutable the instant the referred Shop is created. */
    locksAt: "shop_creation",
    /** A code typed during signup beats a cookie, but only BEFORE the lock. */
    explicitCodeBeatsCookie: true,
    /** Platform admin may correct an attribution this long after the lock -
     *  written reason + audit event required, nothing else may ever change it. */
    adminCorrectionWindowDays: 7,
  },
  qualification: {
    /** Successful, NON-ZERO, base-subscription invoices required. Distinct
     *  Stripe invoice ids - webhook replays never count twice. */
    qualifyingInvoices: 2,
    /** Days after the second qualifying invoice before the reward is available. */
    holdDaysAfterSecond: 14,
  },
  reward: {
    /** v1: subscription credit only. Never cash, never transferable. */
    kind: "subscription_credit",
    /** One month of the REFERRER'S own current base plan at qualification
     *  time (pro or pro_ai) - the receptionist ADD-ON subscription, tax, SMS
     *  usage, fees and one-time purchases are always excluded. */
    basis: "referrer_base_subscription_at_qualification",
    excludes: ["tax", "sms", "addons", "fees", "one_time"],
    /** An AVAILABLE reward expires this many months after becoming available. */
    expiryMonthsAfterAvailable: 12,
    /** One qualification reward per referred Shop, ever. */
    perReferredShop: 1,
  },
  /**
   * v2: the commission program (owner decision, 2026-10). For every base-plan
   * invoice a referred business pays during its first `months` months -
   * counted from that business's FIRST paid base-plan invoice - the affiliate
   * earns a share of the base-plan amount actually paid (never tax, add-ons,
   * SMS, fees or one-time charges: the same exclusions as `reward`).
   *
   * The affiliate chooses CASH or CREDIT (ChairBack bill credit); the choice
   * at the moment an invoice is paid is frozen onto that commission line, so
   * changing it later never rewrites what was already earned.
   *
   * Each line is HELD for `holdDays` (the refund/dispute window) and becomes
   * AVAILABLE only once that has passed AND the referred business has paid at
   * least `qualification.qualifyingInvoices` base-plan invoices - nothing is
   * ever paid on a one-month signup.
   *
   * Rates are basis points so the math stays in integers.
   */
  commission: {
    /** 20% of the base-plan amount when the affiliate chose cash. */
    cashBps: 2000,
    /** 30% when they chose ChairBack bill credit. */
    creditBps: 3000,
    /** Invoices paid in this many calendar months from the first one earn. */
    months: 12,
    /** Days each commission line is held before it can become available. */
    holdDays: 30,
    /** Available cash below this is carried forward, never paid out. */
    minimumCashPayoutCents: 2500,
  },
  review: {
    /** More qualified rewards than this in a rolling year holds further
     *  rewards for admin review. Held, never silently discarded. */
    rollingYearQualifiedThreshold: 12,
  },
  suspension: {
    /** Suspension never erases history - rows, codes and audit events stay. */
    keepsHistory: true,
    /** A suspended affiliate's code stops earning NEW attribution. */
    earnsNewAttribution: false,
  },
} as const;

export type AffiliatePolicy = typeof AFFILIATE_POLICY;

/** How an affiliate takes their commission. Mirrors
 *  AffiliateAccount_payoutPreference_check and AffiliateCommission_kind_check.
 *  `credit` is the default: it is what the v1 program paid, so an affiliate
 *  who never chooses is never moved onto cash without saying so. */
export const AFFILIATE_PAYOUT_PREFERENCES = ["credit", "cash"] as const;
export type AffiliatePayoutPreference = (typeof AFFILIATE_PAYOUT_PREFERENCES)[number];

/** Mirrors AffiliateCommission_status_check. */
export const AFFILIATE_COMMISSION_STATUSES = [
  "HELD",
  "AVAILABLE",
  "REVIEW_REQUIRED",
  "PAID",
  "REVERSED",
] as const;
export type AffiliateCommissionStatus = (typeof AFFILIATE_COMMISSION_STATUSES)[number];

/** The rate, in basis points, for a payout kind. */
export function commissionRateBps(kind: AffiliatePayoutPreference): number {
  return kind === "cash"
    ? AFFILIATE_POLICY.commission.cashBps
    : AFFILIATE_POLICY.commission.creditBps;
}

/**
 * The commission on a base-plan amount, in whole cents, ROUNDED DOWN.
 *
 * Integer math only (cents x basis points / 10,000): a float percentage would
 * drift a cent across enough invoices, and rounding down means the program
 * never promises a fraction of a cent it then has to find. Anything that is
 * not a positive whole number of cents earns nothing rather than a guess.
 */
export function commissionCents(
  baseCents: number,
  kind: AffiliatePayoutPreference,
): number {
  if (!Number.isSafeInteger(baseCents) || baseCents <= 0) return 0;
  return Math.floor((baseCents * commissionRateBps(kind)) / 10_000);
}

/**
 * THE COMMISSION, IN WORDS. Every affiliate-facing sentence (the Affiliates
 * tab, the terms page, the approval email) reads its numbers from here, so a
 * change to AFFILIATE_POLICY.commission or to a plan price moves the copy with
 * it - nothing downstream writes "20%" or "$25" by hand.
 *
 * 🔴 DOLLARS AND PERCENTAGES ARE WEB-ONLY. Inside the iOS app the tab and the
 * terms wrap these in HideInNativeApp (App Store Guideline 3.1.1); the plain
 * descriptions below (`commissionPeriodPhrase`, `ordinal`) carry no money.
 */

/** Basis points as a percent for copy: 2000 -> "20", 2050 -> "20.5". */
export function bpsToPercent(bps: number): string {
  return String(bps / 100);
}

/** Whole cents as dollars for copy: 2500 -> "$25", 699 -> "$6.99". */
export function formatUsdCents(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/** 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4 -> "4th", 11 -> "11th". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** "first year" for 12 months, "first 2 years" for 24, else "first N months". */
export function commissionPeriodPhrase(
  months: number = AFFILIATE_POLICY.commission.months,
): string {
  if (months === 12) return "first year";
  if (months % 12 === 0) return `first ${months / 12} years`;
  return `first ${months} months`;
}

export interface CommissionExample {
  planName: string;
  planCents: number;
  cashMonthlyCents: number;
  creditMonthlyCents: number;
  /** Most a monthly plan earns over the whole window (one invoice a month). */
  cashWindowCents: number;
  creditWindowCents: number;
}

/**
 * The worked example the tab shows: one business on `plan` (the base Premium
 * plan by default) paying full price every month. Uses `commissionCents`, so
 * the example rounds exactly the way the ledger will. The price comes from
 * PLANS - this file still holds no price of its own.
 */
export function commissionExample(
  plan: { name: string; priceMonthlyUsd: number } = PLANS.pro,
): CommissionExample {
  const planCents = Math.round(plan.priceMonthlyUsd * 100);
  const cash = commissionCents(planCents, "cash");
  const credit = commissionCents(planCents, "credit");
  const months = AFFILIATE_POLICY.commission.months;
  return {
    planName: plan.name,
    planCents,
    cashMonthlyCents: cash,
    creditMonthlyCents: credit,
    cashWindowCents: cash * months,
    creditWindowCents: credit * months,
  };
}

/**
 * The instant a referred business stops earning commissions: `months`
 * calendar months after its first paid base-plan invoice, in UTC. An invoice
 * earns only when paid STRICTLY BEFORE this instant, so a monthly plan earns
 * on exactly twelve invoices (the thirteenth falls on the boundary).
 *
 * A day that does not exist in the target month is CLAMPED to that month's
 * last day (Feb 29 -> Feb 28 of a common year) rather than rolling into the
 * next month the way Date#setUTCMonth does - the window never stretches past
 * what the policy says. Time of day is kept.
 */
export function commissionWindowEnd(firstPaidAt: Date): Date {
  const y = firstPaidAt.getUTCFullYear();
  const m = firstPaidAt.getUTCMonth() + AFFILIATE_POLICY.commission.months;
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = m % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(firstPaidAt.getUTCDate(), lastDay),
      firstPaidAt.getUTCHours(),
      firstPaidAt.getUTCMinutes(),
      firstPaidAt.getUTCSeconds(),
      firstPaidAt.getUTCMilliseconds(),
    ),
  );
}

/** Referral code shape: 9 random bytes -> 12 base64url chars (72 bits).
 *  Public by design - it is printed into share links - so it is an
 *  identifier, not a credential; it just has to be unguessable enough that
 *  enumeration finds nothing. */
export const AFFILIATE_CODE_BYTES = 9;

/** Mirrors AffiliateApplication_status_check. */
export const AFFILIATE_APPLICATION_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
] as const;
export type AffiliateApplicationStatus =
  (typeof AFFILIATE_APPLICATION_STATUSES)[number];

/** Mirrors AffiliateAccount_status_check. */
export const AFFILIATE_ACCOUNT_STATUSES = ["ACTIVE", "SUSPENDED"] as const;
export type AffiliateAccountStatus = (typeof AFFILIATE_ACCOUNT_STATUSES)[number];

/** Fixed rejection classifications (mirrors AffiliateApplication_decisionReason_check,
 *  minus 'approved' which the approve path writes). */
export const AFFILIATE_DECISION_REASONS = [
  "incomplete_application",
  "not_eligible",
  "duplicate",
  "policy_violation",
  "other",
] as const;
export type AffiliateDecisionReason = (typeof AFFILIATE_DECISION_REASONS)[number];

/** Fixed suspension classifications (mirrors AffiliateAccount_suspensionReason_check). */
export const AFFILIATE_SUSPENSION_REASONS = [
  "terms_violation",
  "suspected_abuse",
  "admin_review",
  "other",
] as const;
export type AffiliateSuspensionReason =
  (typeof AFFILIATE_SUSPENSION_REASONS)[number];

/** How an applicant says they'll promote. Validated at the API, stored as-is. */
export const AFFILIATE_PROMOTION_CHANNELS = [
  "instagram",
  "tiktok",
  "youtube",
  "facebook",
  "blog",
  "podcast",
  "email_list",
  "in_person",
  "other",
] as const;
export type AffiliatePromotionChannel =
  (typeof AFFILIATE_PROMOTION_CHANNELS)[number];

/**
 * The applicant-visible line for each rejection classification.
 *
 * 🔴 The public message is DERIVED from the fixed classification - admin free
 * text (internalNote) never reaches an applicant, so nothing an admin types in
 * a hurry can leak, and a copy fix here applies to every past decision too.
 * Business-type-neutral on purpose: barbers, salons, nail techs, lash artists,
 * detailers and whatever comes next all read the same sentence.
 */
export const AFFILIATE_DECISION_PUBLIC_COPY: Record<
  AffiliateDecisionReason,
  string
> = {
  incomplete_application:
    "We couldn't verify enough about your business yet. You're welcome to apply again.",
  not_eligible:
    "The program isn't a fit for your account right now. You're welcome to apply again later.",
  duplicate: "Your business already has an affiliate application or account.",
  policy_violation: "Your application couldn't be approved.",
  other: "Your application couldn't be approved at this time.",
};

/**
 * How an APPROVED affiliate says they'll get the word out. Chosen after
 * approval (the flow: sign up -> approve -> choose styles -> dashboard),
 * editable later, and each chosen style switches on its toolkit card.
 * Mirrors AffiliateAccount_promotionStyles_check.
 */
export const AFFILIATE_PROMOTION_STYLES = [
  "short_video",
  "posts_stories",
  "in_the_chair",
  "text_dm",
  "email_list",
  "flyer_qr",
  "blog_podcast",
  "other",
] as const;
export type AffiliatePromotionStyle = (typeof AFFILIATE_PROMOTION_STYLES)[number];

export const AFFILIATE_PROMOTION_STYLE_LABELS: Record<AffiliatePromotionStyle, string> = {
  short_video: "Short video (TikTok, Reels)",
  posts_stories: "Posts and stories",
  in_the_chair: "In the chair, word of mouth",
  text_dm: "Text or DM",
  email_list: "Email list",
  flyer_qr: "Flyer or QR at the shop",
  blog_podcast: "Blog or podcast",
  other: "Something else",
};

/**
 * The affiliate-visible sentence for each suspension classification. Same
 * rule as decisions: derived from the fixed code, so admin prose never leaks.
 */
export const AFFILIATE_SUSPENSION_PUBLIC_COPY: Record<AffiliateSuspensionReason, string> = {
  terms_violation:
    "Your affiliate link is paused because of a terms issue. Your history is kept.",
  suspected_abuse:
    "Your affiliate link is paused while we look into some activity. Your history is kept.",
  admin_review: "Your affiliate link is paused during a review. Your history is kept.",
  other: "Your affiliate link is paused. Your history is kept.",
};

/** Why a month was taken back (mirrors the qualification engine's reasons). */
export const AFFILIATE_REVERSAL_REASONS = [
  "invoice_refunded",
  "payment_disputed",
  "credit_note",
  "admin_adjustment",
] as const;
export type AffiliateReversalReason = (typeof AFFILIATE_REVERSAL_REASONS)[number];

export const AFFILIATE_REVERSAL_PUBLIC_COPY: Record<AffiliateReversalReason, string> = {
  invoice_refunded: "Their payment was refunded, so this month was taken back.",
  payment_disputed: "Their payment was disputed, so this month was taken back.",
  credit_note: "Their invoice was credited back, so this month was taken back.",
  admin_adjustment: "Adjusted after a review.",
};

/**
 * Where a referred business is on the road to a month off. ONE derivation,
 * used by the dashboard, the admin table and the emails - the read/write
 * parity rule: nothing else may name a stage.
 */
export const AFFILIATE_REFERRAL_STAGES = [
  "signed_up",
  "first_payment",
  "second_payment",
  "hold",
  "month_off",
  "applied",
  "reversed",
  "expired",
  "under_review",
] as const;
export type AffiliateReferralStage = (typeof AFFILIATE_REFERRAL_STAGES)[number];

export function affiliateStage(input: {
  qualifyingInvoices: number;
  rewardStatus: string | null;
}): AffiliateReferralStage {
  switch (input.rewardStatus) {
    case "PENDING":
      return "hold";
    case "AVAILABLE":
      return "month_off";
    case "RESERVED":
    case "APPLIED":
      return "applied";
    case "REVERSED":
      return "reversed";
    case "EXPIRED":
      return "expired";
    case "REVIEW_REQUIRED":
      return "under_review";
    default:
      break;
  }
  if (input.qualifyingInvoices >= AFFILIATE_POLICY.qualification.qualifyingInvoices) {
    return "second_payment";
  }
  if (input.qualifyingInvoices === 1) return "first_payment";
  return "signed_up";
}

/** Months off, counted from the reward ledger. One reward = one month. */
export interface AffiliateMonths {
  earned: number;
  onTheWay: number;
  underReview: number;
  reversed: number;
  expired: number;
}

export function affiliateMonths(rewards: ReadonlyArray<{ status: string }>): AffiliateMonths {
  const m: AffiliateMonths = { earned: 0, onTheWay: 0, underReview: 0, reversed: 0, expired: 0 };
  for (const r of rewards) {
    switch (r.status) {
      case "APPLIED":
        m.earned += 1;
        break;
      case "RESERVED":
      case "AVAILABLE":
      case "PENDING":
        m.onTheWay += 1;
        break;
      case "REVIEW_REQUIRED":
        m.underReview += 1;
        break;
      case "REVERSED":
        m.reversed += 1;
        break;
      case "EXPIRED":
        m.expired += 1;
        break;
      default:
        break;
    }
  }
  return m;
}

/**
 * The ONLY label an affiliate may ever see for a business they referred
 * (#360: a referred shop's name never crosses the tenant boundary). The cuid
 * tail is stable, non-identifying, and enough to tell two rows apart.
 */
export function maskBusinessLabel(referredShopId: string): string {
  return "Business ••••" + referredShopId.slice(-4);
}
