/**
 * The connected-assistant panel's data.
 *
 * 🔴 PURE ON PURPOSE - no imports. The panel is a client component and needs
 * these types and `since`; the fetch lives in connections.server.ts because
 * `@/lib/api` pulls in next/headers, which cannot be bundled for the browser.
 *
 * 🔴 EVERY FIELD COMES FROM THE API, including whether the plan allows a
 * connection and what URL to paste. In particular `connectUrl` is NOT built
 * here from a public env var: it is the `resource` every token is bound to
 * (RFC 8707), so the string a human copies and the string the server enforces
 * have to come from the same place or a barber will paste a URL that
 * authenticates and then fails its audience check.
 */

export interface McpConnectionWire {
  id: string;
  clientName: string;
  connectedAt: string;
  lastUsedAt: string | null;
  accessLevel: string;
  mine: boolean;
  connectedBy: string;
  permissions: string[];
}

export interface McpConnectionsWire {
  entitled: boolean;
  requiredPlan: string;
  /** Null when the plan does not include the connector. */
  connectUrl: string | null;
  accessLevel: string;
  connections: McpConnectionWire[];
}

/** Short, human relative time. "2 days ago", not a timestamp. */
export function since(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}
