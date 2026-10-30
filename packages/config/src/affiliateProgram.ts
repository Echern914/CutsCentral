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

/** The affiliate terms document version an applicant accepts. Never edit the
 *  terms text in place - add a version, exactly like the SMS consent rule.
 *  v2 (2026-10-30): dollar account credit ($10 + $5 a month) as the default
 *  reward, a month off per business as the alternative, credit only. */
export const AFFILIATE_TERMS_VERSION = "v2";

/** Bump when any business rule below changes.
 *  v2 (2026-10): the commission program - a percentage of every base-plan
 *  invoice in a referred business's first 12 months, cash or bill credit.
 *  Built as a ledger, never switched on, and RETIRED by v3 before it paid
 *  anyone.
 *  v3 (2026-10-30, owner decision): ACCOUNT CREDIT IN DOLLARS, never cash -
 *  `dollarCredit` below. The affiliate picks a reward style; a month off per
 *  business (the v1 program) stays as the alternative. Accounts keep the
 *  version they were approved under; rewards already earned keep their style. */
export const AFFILIATE_POLICY_VERSION = 3;

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
   * v3: ACCOUNT CREDIT IN DOLLARS (owner decision, 2026-10-30) - the default
   * reward style. Never cash, never transferable: it only ever lowers the
   * affiliate's own ChairBack bill, through the same Stripe customer-balance
   * credit the month-off reward uses.
   *
   *  - `signupCents` once per referred business, earned by that business's
   *    FIRST paid, non-zero, base-plan invoice - never at bare signup, so a
   *    throwaway account on a free trial earns nothing.
   *  - `monthlyCents` for EVERY later paid base-plan invoice, for as long as
   *    the business keeps paying. No cap, no end date; it stops when they do.
   *  - Each credit is tied to the one Stripe invoice that earned it (a unique
   *    key), waits out the same hold as a month off
   *    (`qualification.holdDaysAfterSecond`), and is reversed if THAT invoice
   *    is refunded, disputed or credited back before the credit is applied.
   *  - Dollar credit does NOT expire (`expires: false`); unused credit carries
   *    forward on the affiliate's Stripe balance. Credit earned while the
   *    affiliate has no active plan waits until they pay again.
   */
  dollarCredit: {
    signupCents: 1000,
    monthlyCents: 500,
    currency: "usd",
    expires: false,
  },
  /**
   * v2: the commission program (owner decision, 2026-10). RETIRED by v3
   * before it ever paid anyone - nothing earns commission lines any more; the
   * numbers stay so lines that may exist still read correctly. For every base-plan
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

/**
 * How an affiliate is rewarded - ONE choice per affiliate account, changeable
 * at any time, and read when each reward is EARNED: changing it only affects
 * rewards earned afterwards. Mirrors AffiliateAccount_rewardStyle_check.
 *
 *  - `dollar_credit` (the default for new affiliates): $10 account credit per
 *    business on its first paid invoice, then $5 for every later paid month.
 *  - `month_off`: the v1 program - one month of the affiliate's own plan per
 *    business that has paid twice.
 */
export const AFFILIATE_REWARD_STYLES = ["dollar_credit", "month_off"] as const;
export type AffiliateRewardStyle = (typeof AFFILIATE_REWARD_STYLES)[number];
export const DEFAULT_AFFILIATE_REWARD_STYLE: AffiliateRewardStyle = "dollar_credit";

export function isAffiliateRewardStyle(v: unknown): v is AffiliateRewardStyle {
  return typeof v === "string" && (AFFILIATE_REWARD_STYLES as readonly string[]).includes(v);
}

/**
 * What a reward row IS. Mirrors AffiliateReward_rewardType_check.
 *  - `subscription_credit`: a month off (v1 / month_off style).
 *  - `signup_credit`: the one-time dollar credit for bringing a business on.
 *  - `monthly_credit`: the dollar credit for each later paid month.
 *
 * A referred business earns exactly ONE "bring-on" reward ever - a month off
 * OR the sign-up credit, whichever style its affiliate had when it became due
 * (a partial unique index, not a check).
 */
export const AFFILIATE_REWARD_TYPES = [
  "subscription_credit",
  "signup_credit",
  "monthly_credit",
] as const;
export type AffiliateRewardType = (typeof AFFILIATE_REWARD_TYPES)[number];
export const AFFILIATE_BRING_ON_REWARD_TYPES = ["subscription_credit", "signup_credit"] as const;
export const AFFILIATE_DOLLAR_REWARD_TYPES = ["signup_credit", "monthly_credit"] as const;

export function isDollarRewardType(t: string | null | undefined): boolean {
  return t === "signup_credit" || t === "monthly_credit";
}

/** The credit, in cents, for a dollar reward type. */
export function dollarCreditCents(type: "signup_credit" | "monthly_credit"): number {
  return type === "signup_credit"
    ? AFFILIATE_POLICY.dollarCredit.signupCents
    : AFFILIATE_POLICY.dollarCredit.monthlyCents;
}

/** "$10", "$5", "$12.50" - whole dollars print without cents. */
export function formatCreditUsd(cents: number): string {
  const safe = Number.isFinite(cents) ? Math.max(0, Math.round(cents)) : 0;
  const dollars = Math.floor(safe / 100);
  const rest = safe % 100;
  const whole = dollars.toLocaleString("en-US");
  return rest === 0 ? `$${whole}` : `$${whole}.${String(rest).padStart(2, "0")}`;
}

/**
 * The style's name WITH its dollar amounts. 🔴 Web only: these carry prices,
 * which the iOS app shell must never show (App Store Guideline 3.1.1). Inside
 * the app use AFFILIATE_REWARD_STYLE_NEUTRAL_LABELS.
 */
export const AFFILIATE_REWARD_STYLE_LABELS: Record<AffiliateRewardStyle, string> = {
  dollar_credit: `Account credit (${formatCreditUsd(AFFILIATE_POLICY.dollarCredit.signupCents)} + ${formatCreditUsd(AFFILIATE_POLICY.dollarCredit.monthlyCents)}/month)`,
  month_off: "A month off per business",
};

/** The same styles with no amounts - safe inside the app. */
export const AFFILIATE_REWARD_STYLE_NEUTRAL_LABELS: Record<AffiliateRewardStyle, string> = {
  dollar_credit: "Account credit",
  month_off: "A month off per business",
};

/** Dollar credit in each state, in cents. Counted from the reward ledger. */
export interface AffiliateCreditTotals {
  /** Everything earned and not taken back: in the hold + ready + applied. */
  earnedCents: number;
  /** Earned, waiting out the hold. */
  inHoldCents: number;
  /** Past the hold, or being put on a bill right now. */
  readyCents: number;
  /** Already taken off a ChairBack bill. */
  appliedCents: number;
  underReviewCents: number;
  reversedCents: number;
}

export function affiliateCreditTotals(
  rewards: ReadonlyArray<{ status: string; rewardType?: string | null; amountCents: number }>,
): AffiliateCreditTotals {
  const t: AffiliateCreditTotals = {
    earnedCents: 0,
    inHoldCents: 0,
    readyCents: 0,
    appliedCents: 0,
    underReviewCents: 0,
    reversedCents: 0,
  };
  for (const r of rewards) {
    if (!isDollarRewardType(r.rewardType)) continue;
    const c = r.amountCents;
    switch (r.status) {
      case "PENDING":
        t.inHoldCents += c;
        break;
      case "AVAILABLE":
      case "RESERVED":
        t.readyCents += c;
        break;
      case "APPLIED":
        t.appliedCents += c;
        break;
      case "REVIEW_REQUIRED":
        t.underReviewCents += c;
        break;
      case "REVERSED":
        t.reversedCents += c;
        break;
      default:
        break;
    }
  }
  t.earnedCents = t.inHoldCents + t.readyCents + t.appliedCents;
  return t;
}

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

/** Why a reward was taken back (mirrors the qualification engine's reasons). */
export const AFFILIATE_REVERSAL_REASONS = [
  "invoice_refunded",
  "payment_disputed",
  "credit_note",
  "admin_adjustment",
] as const;
export type AffiliateReversalReason = (typeof AFFILIATE_REVERSAL_REASONS)[number];

export const AFFILIATE_REVERSAL_PUBLIC_COPY: Record<AffiliateReversalReason, string> = {
  invoice_refunded: "Their payment was refunded, so this reward was taken back.",
  payment_disputed: "Their payment was disputed, so this reward was taken back.",
  credit_note: "Their invoice was credited back, so this reward was taken back.",
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

/** Months off, counted from the reward ledger. One month-off reward = one
 *  month; dollar credits (signup_credit / monthly_credit) are not months and
 *  are counted by affiliateCreditTotals instead. A row with no rewardType is
 *  read as a month (every reward written before v3 was one). */
export interface AffiliateMonths {
  earned: number;
  onTheWay: number;
  underReview: number;
  reversed: number;
  expired: number;
}

export function affiliateMonths(
  rewards: ReadonlyArray<{ status: string; rewardType?: string | null }>,
): AffiliateMonths {
  const m: AffiliateMonths = { earned: 0, onTheWay: 0, underReview: 0, reversed: 0, expired: 0 };
  for (const r of rewards) {
    if (isDollarRewardType(r.rewardType)) continue;
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
