/**
 * App-wide constants. The product name lives here ONLY — rename in one place.
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
