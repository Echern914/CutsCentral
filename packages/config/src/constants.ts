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
  /** Bare webhook action values (NOT dotted). */
  actions: ["scheduled", "rescheduled", "canceled", "changed"] as const,
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
