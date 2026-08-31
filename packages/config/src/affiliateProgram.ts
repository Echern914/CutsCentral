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
 *  terms text in place - add a version, exactly like the SMS consent rule. */
export const AFFILIATE_TERMS_VERSION = "v1";

/** Bump when any business rule below changes. */
export const AFFILIATE_POLICY_VERSION = 1;

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
