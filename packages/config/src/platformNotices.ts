/**
 * PLATFORM NOTICES - "we know about it and we're fixing it".
 *
 * A barber asked to be told when something is broken or being worked on, the
 * way other apps post a maintenance or bug notice. The platform owner posts one
 * from the admin portal; every barber's dashboard shows it as a banner while it
 * is live, and the header bell lists it.
 *
 * Shared here because three places must agree on it: the API (which decides
 * what is live and enforces the limits), the admin form (which writes it) and
 * the dashboard banner (which styles it by severity).
 */

export const PLATFORM_NOTICE_SEVERITIES = ["info", "maintenance", "issue"] as const;
export type PlatformNoticeSeverity = (typeof PLATFORM_NOTICE_SEVERITIES)[number];

/** What the admin form and the banner call each severity. */
export const PLATFORM_NOTICE_SEVERITY_LABEL: Record<PlatformNoticeSeverity, string> = {
  info: "Info",
  maintenance: "Maintenance",
  issue: "Known issue",
};

/** A banner line, not an essay: it sits at the top of every dashboard page. */
export const PLATFORM_NOTICE_TITLE_MAX = 80;
export const PLATFORM_NOTICE_BODY_MAX = 500;

/**
 * How long a resolved notice keeps showing as "Fixed" before it drops off. Long
 * enough that a barber who saw the problem in the morning sees it was fixed
 * when they next open the app; short enough that it is not news by tomorrow.
 */
export const PLATFORM_NOTICE_FIXED_SHOWS_MS = 6 * 60 * 60 * 1000;

/**
 * Where a notice is in its life, at `now`:
 *  - scheduled: starts later (posted ahead of planned maintenance);
 *  - active:    live - the banner shows;
 *  - resolved:  marked fixed within the last few hours - a short "Fixed" banner;
 *  - ended:     past its end time, or fixed long enough ago - shows nowhere.
 *
 * The end time wins over a recent fix: a notice whose window closed is over.
 */
export type PlatformNoticeState = "scheduled" | "active" | "resolved" | "ended";

export function platformNoticeState(
  n: { startsAt: Date; endsAt: Date | null; resolvedAt: Date | null },
  now: Date,
): PlatformNoticeState {
  const t = now.getTime();
  if (n.endsAt && n.endsAt.getTime() <= t) return "ended";
  if (n.resolvedAt) {
    // Resolved before it ever started (planned work called off): nothing to
    // announce as fixed.
    if (n.startsAt.getTime() > t) return "ended";
    return t - n.resolvedAt.getTime() < PLATFORM_NOTICE_FIXED_SHOWS_MS ? "resolved" : "ended";
  }
  if (n.startsAt.getTime() > t) return "scheduled";
  return "active";
}

/** Shown on a barber's dashboard (banner + bell) in this state. */
export function platformNoticeVisible(state: PlatformNoticeState): boolean {
  return state === "active" || state === "resolved";
}

/** The push's body: the notice's first line, cut to fit a lock screen. */
export function platformNoticePushBody(body: string): string {
  const first = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return first.length > 140 ? `${first.slice(0, 139).trimEnd()}…` : first;
}
