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
  priceMonthlyUsd: 34.99,
  trialDays: 30,
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
