import { apiGet } from "@/lib/api";
import type { McpConnectionsWire } from "./connections";

/**
 * The connected-assistant fetch, kept in its own SERVER-ONLY module.
 *
 * 🔴 THE SPLIT IS LOAD-BEARING, NOT TIDINESS. `@/lib/api` imports
 * `next/headers`, so anything importing it can only be a server component. The
 * panel is a client component and needs the TYPES and the `since` helper from
 * connections.ts - if the fetch lived there too, that one value import would
 * drag next/headers into the client bundle and the web build fails outright.
 */
export async function getConnections(): Promise<McpConnectionsWire | null> {
  const res = await apiGet<McpConnectionsWire>("/api/mcp/connections");
  // 🔴 Null on any failure, never a throw. The Assistant tab must render with
  // the MCP surface completely down: readiness, help and navigation are all
  // computed from data ChairBack already holds, and a throw here would take the
  // whole page with it - turning "the connector is unavailable" into "the
  // Assistant is broken", which is the failure this design exists to avoid.
  return res.ok && res.data ? res.data : null;
}
