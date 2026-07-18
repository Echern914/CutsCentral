/**
 * App-wide constants. The product name lives here ONLY - rename in one place.
 */
export const APP_NAME = "ChairBack";

/** Default loyalty + nudge settings applied to newly created shops. */
export const DEFAULTS = {
  rewardThreshold: 10,
  rewardLabel: "Free Cut",
  nudgeBufferDays: 7,
  dailySendCap: 50,
  timezone: "America/New_York",
} as const;

/**
 * The pricing tiers. Stripe owns the live prices (STRIPE_PRICE_ID /
 * STRIPE_PREMIUM_AI_PRICE_ID); the numbers here are what the marketing site
 * and billing page DISPLAY, so keep them in sync with the Stripe dashboard
 * when a price changes. `key` doubles as the internal Shop.plan value (the
 * display name differs: "pro" shows as "Premium", "pro_ai" as "Premium AI").
 *
 * smsMonthlyQuota = included marketing texts per UTC calendar month (nudge /
 * win-back / promo / receptionist gap-fill kinds). Hard stop at the quota -
 * no metered overage; the dashboard shows a usage meter + upgrade CTA. See
 * apps/api/src/billing/quota.ts for enforcement.
 */
export const PLANS = {
  free: {
    key: "free",
    name: "Free",
    priceMonthlyUsd: 0,
    smsMonthlyQuota: 0,
    receptionistIncluded: false,
  },
  pro: {
    key: "pro",
    name: "Premium",
    priceMonthlyUsd: 34.99,
    smsMonthlyQuota: 600,
    receptionistIncluded: false,
  },
  pro_ai: {
    key: "pro_ai",
    name: "Premium AI",
    priceMonthlyUsd: 74.99,
    smsMonthlyQuota: 2500,
    receptionistIncluded: true,
  },
} as const;

export type PlanKey = keyof typeof PLANS;

/**
 * Back-compat alias over PLANS.pro (the original single paid plan). Existing
 * call sites (billing route, web banner/FAQ/vertical pages) read this; new
 * code should use PLANS directly.
 */
export const BILLING = {
  planName: PLANS.pro.name,
  priceMonthlyUsd: PLANS.pro.priceMonthlyUsd,
  trialDays: 30,
} as const;

/**
 * Shop verticals. The product is service-business generic (Shop/Client/Visit);
 * industry only flavors defaults and copy. `defaultReward` seeds the first
 * loyalty menu item during onboarding. `serviceNoun` is the singular word for a
 * visit in that vertical ("cut", "appointment") used in customer-facing copy
 * (e.g. the default rebooking text "since your last {serviceNoun}") so a nail
 * studio's clients aren't texted about a "cut".
 */
export const INDUSTRIES = {
  barber: { label: "Barbershop", defaultReward: "Free Cut", emoji: "✂️", serviceNoun: "cut" },
  salon: { label: "Hair Salon", defaultReward: "Free Blowout", emoji: "💇", serviceNoun: "appointment" },
  nails: { label: "Nail Studio", defaultReward: "Free Manicure", emoji: "💅", serviceNoun: "appointment" },
  lashes: { label: "Lash & Brow Studio", defaultReward: "Free Lash Fill", emoji: "👁️", serviceNoun: "appointment" },
  spa: { label: "Spa & Skincare", defaultReward: "Free Facial Add-On", emoji: "🧖", serviceNoun: "appointment" },
  tattoo: { label: "Tattoo & Piercing", defaultReward: "$25 Off Next Session", emoji: "🖋️", serviceNoun: "session" },
  other: { label: "Other", defaultReward: "Free Service", emoji: "⭐", serviceNoun: "visit" },
} as const;

export type IndustryKey = keyof typeof INDUSTRIES;

export const INDUSTRY_KEYS = Object.keys(INDUSTRIES) as IndustryKey[];

/**
 * Self-reported visit cadence (Client.preferredCadence). Captured as one tap at
 * the customer's first app open and used as a COLD-START seed for rebook timing
 * until the client has enough visit history for a computed cadence (see
 * NUDGE.minCompletedVisits). Keys mirror the Prisma `CadencePreference` enum 1:1.
 * `days` feeds nextExpectedAt; `label`/`short` are the chip copy. Ordered most ->
 * least frequent (the order the chips render in).
 */
export const CADENCE_OPTIONS = {
  WEEKLY: { label: "Every week", short: "Weekly", days: 7 },
  BIWEEKLY: { label: "Every 2 weeks", short: "2 weeks", days: 14 },
  EVERY_3_WEEKS: { label: "Every 3 weeks", short: "3 weeks", days: 21 },
  MONTHLY: { label: "Once a month", short: "Monthly", days: 30 },
  OCCASIONAL: { label: "Every so often", short: "Sometimes", days: 56 },
} as const;

export type CadenceKey = keyof typeof CADENCE_OPTIONS;

export const CADENCE_KEYS = Object.keys(CADENCE_OPTIONS) as CadenceKey[];

/** Days to seed nextExpectedAt for a self-reported cadence. */
export function cadenceToDays(key: CadenceKey): number {
  return CADENCE_OPTIONS[key].days;
}

/**
 * Loyalty status tiers (Client.loyaltyTier). Keys mirror the Prisma `LoyaltyTier`
 * enum 1:1. Default thresholds key off lifetime COMPLETED visits; a shop may
 * override these later (eventually a per-shop tier table). A client is in the
 * HIGHEST tier whose `minVisits` they meet, or no tier below the first. Ordered
 * low -> high. `color` is the accent shown on the rewards page + dashboard chip.
 */
export const LOYALTY_TIERS = {
  BRONZE: { label: "Bronze", minVisits: 1, color: "#B8772F" },
  SILVER: { label: "Silver", minVisits: 6, color: "#C7CBD1" },
  GOLD: { label: "Gold", minVisits: 12, color: "#D4AF37" },
} as const;

export type LoyaltyTierKey = keyof typeof LOYALTY_TIERS;

export const LOYALTY_TIER_KEYS = Object.keys(LOYALTY_TIERS) as LoyaltyTierKey[];

/** The loyalty tier a client earns at a given lifetime completed-visit count (or null). */
export function loyaltyTierForVisits(completedVisits: number): LoyaltyTierKey | null {
  let earned: LoyaltyTierKey | null = null;
  for (const key of LOYALTY_TIER_KEYS) {
    if (completedVisits >= LOYALTY_TIERS[key].minVisits) earned = key;
  }
  return earned;
}

/**
 * Coarse "how often do they come" buckets for the dashboard, derived from a
 * client's cadence in DAYS (the computed medianIntervalDays, else the
 * self-reported preferredCadence via CADENCE_OPTIONS). Display + light
 * segmentation only — nudge timing still uses the precise interval. `maxDays` is
 * the inclusive upper bound of the bucket; ordered tightest -> loosest.
 */
export const FREQUENCY_SEGMENTS = {
  weekly: { label: "Weekly", maxDays: 10 },
  biweekly: { label: "Every 2 wks", maxDays: 17 },
  triweekly: { label: "Every 3 wks", maxDays: 24 },
  monthly: { label: "Monthly", maxDays: 45 },
  occasional: { label: "Occasional", maxDays: 3650 },
} as const;

export type FrequencySegmentKey = keyof typeof FREQUENCY_SEGMENTS;

export const FREQUENCY_SEGMENT_KEYS = Object.keys(
  FREQUENCY_SEGMENTS,
) as FrequencySegmentKey[];

/** Bucket a cadence (in days) into a coarse segment; null when no cadence is known. */
export function frequencySegment(
  days: number | null | undefined,
): FrequencySegmentKey | null {
  if (days == null) return null;
  for (const key of FREQUENCY_SEGMENT_KEYS) {
    if (days <= FREQUENCY_SEGMENTS[key].maxDays) return key;
  }
  return "occasional";
}

/**
 * The singular visit-noun for a vertical ("cut" | "appointment" | "session" |
 * "visit"). Falls back to a neutral "visit" for an unknown/empty industry, so
 * customer copy is never wrong (just generic). Used by the SMS/push nudge.
 */
export function serviceNounFor(industry: string | null | undefined): string {
  if (!industry) return "visit";
  return (INDUSTRIES as Record<string, { serviceNoun?: string }>)[industry]?.serviceNoun ?? "visit";
}

/** Nudge engine windows. */
export const NUDGE = {
  /** Minimum completed visits before a client has enough history for a cadence. */
  minCompletedVisits: 2,
  /** Do not nudge a client more than once within this many days. */
  suppressionDays: 21,
  /** A booking within this many days after a nudge is attributed to that nudge. */
  attributionWindowDays: 7,
} as const;

/**
 * Win-back ("Growth Agent") targeting. A win-back is for the DEEPLY lapsed -
 * clients well past their own cadence whom the regular rebooking nudge already
 * tried and who are drifting away. Two things separate it from a plain nudge:
 *  - a much higher overdue bar (a MULTIPLE of their median interval, not just
 *    median + buffer), so we only "we miss you" the genuinely gone, and
 *  - a long re-nag suppression (90d, vs the nudge's 21d), so a lapsed client is
 *    contacted at most a few times a year, never pestered.
 * The send still passes the SAME consent + quiet-hours + billing gates.
 */
export const WINBACK = {
  /** Need real cadence history (shared bar with the nudge). */
  minCompletedVisits: 2,
  /**
   * Overdue threshold = medianIntervalDays * this multiplier. e.g. a 28-day
   * client is win-back-eligible only once ~84 days (3x) have passed since their
   * last visit - well beyond the ordinary "overdue" nudge window.
   */
  overdueMultiplier: 3,
  /** Do not send another win-back to the same client within this many days. */
  suppressionDays: 90,
  /** A booking within this many days after a win-back is attributed to it. */
  attributionWindowDays: 14,
} as const;

/**
 * TCPA quiet-hours safe harbor: marketing/informational SMS may only be sent
 * 8:00am-9:00pm in the RECIPIENT's local time. Clients are nearly always local
 * to the shop, so we gate on the shop's timezone. Sending outside this window
 * is the kind of violation plaintiffs' firms troll for ($500-$1,500 per text).
 *
 * Window is [startHour, endHour): a send is allowed when the recipient-local
 * hour h satisfies startHour <= h < endHour. With 8..21 that permits any time
 * from 08:00:00 through 20:59:59 and blocks 21:00:00 through 07:59:59.
 */
export const QUIET_HOURS = {
  /** First allowed local hour (inclusive), 0-23. */
  startHour: 8,
  /** First disallowed local hour (i.e. last allowed hour is endHour-1), 0-23. */
  endHour: 21,
} as const;

/** Acuity API endpoints (verified against developers.acuityscheduling.com). */
export const ACUITY = {
  apiBase: "https://acuityscheduling.com/api/v1",
  authorizeUrl: "https://acuityscheduling.com/oauth2/authorize",
  tokenUrl: "https://acuityscheduling.com/oauth2/token",
  scope: "api-v1",
  // IMPORTANT: Acuity uses TWO different event vocabularies.
  // 1) INCOMING webhook payloads send BARE action strings ("scheduled") in the
  //    POST body - the webhook receiver matches on these.
  actions: ["scheduled", "rescheduled", "canceled", "changed"] as const,
  // 2) The Dynamic Webhooks SUBSCRIPTION API (POST /webhooks) requires DOTTED
  //    event names ("appointment.scheduled"). Sending bare names here makes the
  //    POST fail and no subscription is created (verified live 2026-06-14).
  subscriptionEvents: [
    "appointment.scheduled",
    "appointment.rescheduled",
    "appointment.canceled",
    "appointment.changed",
  ] as const,
} as const;

/**
 * Square Appointments OAuth + Bookings API. Mirrors the ACUITY block. Square
 * splits sandbox vs production by HOST (different creds + webhook signature key
 * per env), selected by SQUARE_ENV. The connect host serves BOTH the REST API
 * and the OAuth endpoints.
 *
 * [VERIFY IN SANDBOX] the pinned apiVersion, the exact ObtainToken request shape,
 * and whether ListBookings returns cancelled bookings (see square/backfill.ts).
 */
export const SQUARE = {
  hosts: {
    sandbox: "https://connect.squareupsandbox.com",
    production: "https://connect.squareup.com",
  },
  // Pinned Square-Version header sent on every API call. Bump deliberately (+test).
  // 2026-05-20 = the version the sandbox app's webhook subscription is built
  // against (Square ties webhook payload shape + API responses to the version),
  // so the Square-Version header and the webhook stay consistent. Override per
  // env with SQUARE_API_VERSION if Square advances the app's default again.
  apiVersion: "2026-05-20",
  // OAuth + token paths (appended to the env-selected host).
  authorizePath: "/oauth2/authorize",
  tokenPath: "/oauth2/token",
  // BOTH appointment scopes are required: APPOINTMENTS_READ alone only surfaces
  // bookings OUR app created — APPOINTMENTS_ALL_READ is what delivers a seller's
  // EXISTING bookings via ListBookings + webhooks. CUSTOMERS_READ for contacts.
  scope: "APPOINTMENTS_READ APPOINTMENTS_ALL_READ CUSTOMERS_READ MERCHANT_PROFILE_READ",
  // Booking webhook events. booking.updated carries cancellations (status flips
  // to a CANCELLED_* value); there is no separate booking.canceled event.
  webhookEvents: ["booking.created", "booking.updated"] as const,
} as const;

export type SquareEnv = "sandbox" | "production";

/** The connect host (REST + OAuth) for the selected Square environment. */
export function squareHost(env: SquareEnv): string {
  return SQUARE.hosts[env];
}

/** Far-past date the backfill walks from. */
export const BACKFILL_MIN_DATE = "2015-01-01";

/** Barber session cookie name (shared by api + web; plain constant, no node deps). */
export const SESSION_COOKIE_NAME = "cb_session";

/**
 * Active-shop selection cookie (shared by api + web). For a manager who owns
 * more than one shop, this NAMES which owned shop the dashboard is currently
 * acting on. It is only ever a HINT: requireShop re-verifies that the named shop
 * is owned by the session user and falls back to their first shop otherwise, so
 * a forged value can never reach another tenant's data.
 */
export const ACTIVE_SHOP_COOKIE_NAME = "cb_active_shop";

/**
 * How a shop's public page books appointments. "native" = the in-house engine;
 * "acuity" / "square" = a synced platform whose booking site the Book button
 * opens via Shop.bookingUrl (Square stores no booking-site URL of its own — the
 * barber pastes theirs); "link" = a plain external URL. Shared by the API
 * schema and both web surfaces so the union can never drift (a hand-copied
 * union missing "square" once hid the Book button for every Square shop).
 */
export const BOOKING_MODES = ["link", "acuity", "native", "square"] as const;

export type BookingModeKey = (typeof BOOKING_MODES)[number];

/**
 * Public page handle: 3-40 chars of lowercase letters/digits/dashes, starting
 * and ending with a letter or digit. Shared by the API schema and the page
 * editor's client-side validation so the two can never drift.
 */
export const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

/** Accent color override: a full 6-digit hex like #D4AF37. Shared like SLUG_REGEX. */
export const ACCENT_HEX_REGEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Public shop page theme presets. The shop's accentColor (if set) overrides
 * the preset accent; everything else keys off these tokens so each barber's
 * page can look like THEIR shop, not like the product.
 */
export const PAGE_THEMES = {
  classic: {
    label: "Classic Gold",
    bg: "#0A0A0B",
    surface: "#161618",
    border: "rgba(245,245,244,0.10)",
    text: "#F5F5F4",
    muted: "#A1A1AA",
    accent: "#D4AF37",
    scheme: "dark",
  },
  midnight: {
    label: "Midnight Blue",
    bg: "#090E1C",
    surface: "#111A30",
    border: "rgba(226,235,255,0.10)",
    text: "#EDF1FA",
    muted: "#8B96B3",
    accent: "#5B8CFF",
    scheme: "dark",
  },
  crisp: {
    label: "Crisp Light",
    bg: "#F7F6F2",
    surface: "#FFFFFF",
    border: "rgba(22,22,26,0.10)",
    text: "#1A1A1E",
    muted: "#6B6B70",
    accent: "#A07807",
    scheme: "light",
  },
  blade: {
    label: "Blade Red",
    bg: "#120C0C",
    surface: "#1D1313",
    border: "rgba(247,239,234,0.10)",
    text: "#F7EFEA",
    muted: "#A18F8A",
    accent: "#E0453A",
    scheme: "dark",
  },
} as const;

export type PageThemeKey = keyof typeof PAGE_THEMES;

export const PAGE_THEME_KEYS = Object.keys(PAGE_THEMES) as PageThemeKey[];

/**
 * Font pairings the barber can pick for their public page. Each maps a heading
 * (display) + body family. The public route (/s/[slug]) loads these via
 * next/font and exposes them as CSS variables; the editor preview and public
 * page both read `cssVar` so a shop's typography is part of its identity.
 * Keep these families in sync with the next/font loader in the /s layout.
 */
export const PAGE_FONTS = {
  modern: {
    label: "Modern",
    hint: "Clean grotesque",
    displayVar: "--font-page-bricolage",
    bodyVar: "--font-page-inter",
  },
  classic: {
    label: "Classic Serif",
    hint: "Editorial, timeless",
    displayVar: "--font-page-playfair",
    bodyVar: "--font-page-inter",
  },
  bold: {
    label: "Bold Display",
    hint: "Loud, condensed",
    displayVar: "--font-page-archivo",
    bodyVar: "--font-page-inter",
  },
  clean: {
    label: "Clean Sans",
    hint: "Minimal, neutral",
    displayVar: "--font-page-inter",
    bodyVar: "--font-page-inter",
  },
} as const;

export type PageFontKey = keyof typeof PAGE_FONTS;

export const PAGE_FONT_KEYS = Object.keys(PAGE_FONTS) as PageFontKey[];

export const DEFAULT_PAGE_FONT: PageFontKey = "modern";

/**
 * Layout "shape" presets: corner roundness + button shape. Pure CSS tokens the
 * public page and preview consume so a shop can read sharp/editorial or soft/
 * friendly without touching colors.
 */
export const LAYOUT_STYLES = {
  soft: { label: "Soft", radius: "1rem", buttonRadius: "9999px" },
  sharp: { label: "Sharp", radius: "0.25rem", buttonRadius: "0.25rem" },
  round: { label: "Round", radius: "1.5rem", buttonRadius: "9999px" },
} as const;

export type LayoutStyleKey = keyof typeof LAYOUT_STYLES;

export const LAYOUT_STYLE_KEYS = Object.keys(LAYOUT_STYLES) as LayoutStyleKey[];

export const DEFAULT_LAYOUT_STYLE: LayoutStyleKey = "soft";

/**
 * Reorderable / toggleable sections on the public page. The hero + booking CTA
 * are fixed (always first); these are the movable blocks. `sectionOrder` on the
 * shop is an array of these keys in render order; any section omitted from the
 * array is hidden. An empty array means "use DEFAULT_SECTION_ORDER" (back-comp
 * for shops created before this field existed).
 */
export const PAGE_SECTIONS = {
  promotions: { label: "Promotions", hint: "Live deals" },
  rewards: { label: "Loyalty rewards", hint: "Your rewards menu" },
  reviews: { label: "Reviews", hint: "What clients say" },
  gallery: { label: "Gallery", hint: "Your work" },
  hours: { label: "Hours", hint: "When you're open" },
} as const;

export type PageSectionKey = keyof typeof PAGE_SECTIONS;

export const PAGE_SECTION_KEYS = Object.keys(PAGE_SECTIONS) as PageSectionKey[];

export const DEFAULT_SECTION_ORDER: PageSectionKey[] = [
  "promotions",
  "rewards",
  "reviews",
  "gallery",
  "hours",
];

/**
 * Optional blocks on the CLIENT rewards page (/r/[magicToken]) the barber can
 * show or hide. Unlike the public page's PAGE_SECTIONS these are NOT reorderable
 * - the rewards page has a deliberate emotional order (balance -> consent ->
 * urgency -> rewards) - so the control is visibility only. The punch balance and
 * the SMS consent card are FIXED (never hideable): the balance is the whole point
 * of the page, and consent is the TCPA lever we must always offer. `rewardsSections`
 * on the shop is the list of VISIBLE keys; [] = "use REWARDS_SECTION_DEFAULT".
 */
export const REWARDS_SECTIONS = {
  rebook: { label: "Rebooking countdown", hint: "Timer urging the next booking" },
  promotions: { label: "Promotions", hint: "Your live deals" },
  rewardMenu: { label: "Reward menu", hint: "What punches unlock" },
  punchGrid: { label: "Punch grid", hint: "Visual progress to the next reward" },
  claimed: { label: "Rewards claimed", hint: "Rewards they've already redeemed" },
  visits: { label: "Recent visits", hint: "Their visit history" },
} as const;

export type RewardsSectionKey = keyof typeof REWARDS_SECTIONS;

export const REWARDS_SECTION_KEYS = Object.keys(REWARDS_SECTIONS) as RewardsSectionKey[];

/** Default visible rewards-page sections (everything on), in declaration order. */
export const REWARDS_SECTION_DEFAULT: RewardsSectionKey[] = [...REWARDS_SECTION_KEYS];

/** Max length of the barber's custom welcome line on the rewards page. */
export const REWARDS_WELCOME_MAX = 140;

/** Max gallery photos a shop can show on its public page. */
export const GALLERY_MAX = 16;

/** Per-photo caption length cap (shared by API validation + editor UI). */
export const GALLERY_CAPTION_MAX = 80;

/** A single gallery photo: an http(s) image URL with an optional caption. */
export interface GalleryItem {
  url: string;
  caption?: string;
}
