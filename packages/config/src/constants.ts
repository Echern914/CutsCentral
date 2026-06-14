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
 * The one paid plan. Stripe owns the live price (STRIPE_PRICE_ID); these
 * numbers are what the marketing site and billing page DISPLAY, so keep them
 * in sync with the Stripe dashboard when the price changes.
 */
export const BILLING = {
  planName: "Pro",
  priceMonthlyUsd: 29,
  trialDays: 14,
} as const;

/**
 * Shop verticals. The product is service-business generic (Shop/Client/Visit);
 * industry only flavors defaults and copy. `defaultReward` seeds the first
 * loyalty menu item during onboarding.
 */
export const INDUSTRIES = {
  barber: { label: "Barbershop", defaultReward: "Free Cut", emoji: "✂️" },
  salon: { label: "Hair Salon", defaultReward: "Free Blowout", emoji: "💇" },
  nails: { label: "Nail Studio", defaultReward: "Free Manicure", emoji: "💅" },
  lashes: { label: "Lash & Brow Studio", defaultReward: "Free Lash Fill", emoji: "👁️" },
  spa: { label: "Spa & Skincare", defaultReward: "Free Facial Add-On", emoji: "🧖" },
  tattoo: { label: "Tattoo & Piercing", defaultReward: "$25 Off Next Session", emoji: "🖋️" },
  other: { label: "Other", defaultReward: "Free Service", emoji: "⭐" },
} as const;

export type IndustryKey = keyof typeof INDUSTRIES;

export const INDUSTRY_KEYS = Object.keys(INDUSTRIES) as IndustryKey[];

/** Nudge engine windows. */
export const NUDGE = {
  /** Minimum completed visits before a client has enough history for a cadence. */
  minCompletedVisits: 2,
  /** Do not nudge a client more than once within this many days. */
  suppressionDays: 21,
  /** A booking within this many days after a nudge is attributed to that nudge. */
  attributionWindowDays: 7,
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

/** Far-past date the backfill walks from. */
export const BACKFILL_MIN_DATE = "2015-01-01";

/** Barber session cookie name (shared by api + web; plain constant, no node deps). */
export const SESSION_COOKIE_NAME = "cb_session";

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
