/**
 * The one line under the Square card saying what the sync actually did.
 *
 * "Connected" used to be the only word on the card, and for every shop that
 * connected it was true while nothing arrived: Square refused each request
 * (a range over its 31-day limit), and no screen said so. The API now records
 * what happened (SquareConnection.backfilledAt / lastSyncedAt / lastSyncError)
 * and this turns it into a sentence.
 */

export interface SquareSyncStatus {
  backfilledAt: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  importedVisits: number;
}

export interface SquareSyncLine {
  /** "refused" = nothing will sync until the shop acts; the card says Reconnect. */
  tone: "ok" | "working" | "warn" | "refused";
  text: string;
}

/**
 * Square's answers that no retry will fix: the connection itself is refused
 * (revoked, expired, missing a permission), or the account has no Square
 * Appointments to read.
 */
const REFUSED = new Set([
  "UNAUTHORIZED",
  "ACCESS_TOKEN_EXPIRED",
  "ACCESS_TOKEN_REVOKED",
  "FORBIDDEN",
  "INSUFFICIENT_SCOPES",
  "http_401",
  "http_403",
]);

export function squareSyncLine(s: SquareSyncStatus, now: Date): SquareSyncLine {
  if (s.lastSyncError && REFUSED.has(s.lastSyncError)) {
    return {
      tone: "refused",
      text:
        "Square refused ChairBack's request, so nothing is syncing. Reconnect Square, and check that " +
        "Square Appointments is turned on for this Square account. Your appointments and settings are kept.",
    };
  }
  if (s.lastSyncError) {
    return {
      tone: "warn",
      text: "The last sync with Square didn't finish. ChairBack tries again every 30 minutes.",
    };
  }
  if (!s.backfilledAt) {
    return {
      tone: "working",
      text: "Importing your Square appointments: past visits and everything booked ahead. This can take a few minutes.",
    };
  }
  const n = s.importedVisits;
  const count = `${n.toLocaleString("en-US")} appointment${n === 1 ? "" : "s"} from Square`;
  return { tone: "ok", text: s.lastSyncedAt ? `${count} · synced ${ago(Date.parse(s.lastSyncedAt), now)}` : count };
}

function ago(at: number, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
