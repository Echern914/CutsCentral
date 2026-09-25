import { shortDate, timeLabel } from "./format";

/**
 * The bell's words and numbers. Pure, so they are tested without a screen.
 *
 * What counts as an announcement, and as unread, is the API's decision
 * (services/customerAnnouncements.ts): the app shows the list and the count
 * exactly as it is told.
 */

export interface Announcement {
  id: string;
  shop: { name: string; logoUrl: string | null };
  title: string | null;
  body: string;
  sentAt: string;
}

export interface Announcements {
  announcements: Announcement[];
  unreadCount: number;
}

export const ANNOUNCEMENTS_PATH = "/api/me/announcements";

/** The badge on the bell: nothing at zero, "9+" past nine. */
export function badgeText(unread: number): string | null {
  if (!Number.isFinite(unread) || unread <= 0) return null;
  return unread > 9 ? "9+" : String(Math.floor(unread));
}

/** What VoiceOver says for the bell - the count is the point of it. */
export function bellLabel(unread: number): string {
  return badgeText(unread) === null ? "Announcements" : `Announcements, ${Math.floor(unread)} new`;
}

/**
 * When a shop sent it: the time today, the date otherwise. On the PHONE's
 * clock - unlike an appointment, a message has no shop wall clock to keep.
 */
export function sentLabel(iso: string, now = new Date(), timeZone = deviceZone()): string {
  return shortDate(iso, timeZone, now) === shortDate(now.toISOString(), timeZone, now)
    ? timeLabel(iso, timeZone)
    : shortDate(iso, timeZone, now);
}

/**
 * How far "mark read" may go: the newest one the customer was actually shown,
 * so one that lands while the screen is open stays new. Null = nothing to mark.
 */
export function readThrough(data: Announcements | undefined): string | null {
  if (!data || data.unreadCount <= 0) return null;
  return data.announcements[0]?.sentAt ?? null;
}

function deviceZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}
