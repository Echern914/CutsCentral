import { businessTools } from "./business.js";
import { calendarTools } from "./calendar.js";
import { clientTools } from "./clients.js";
import { helpTools } from "./help.js";
import { integrationTools } from "./integrations.js";
import { readinessTools } from "./readiness.js";
import { waitlistTools } from "./waitlist.js";
import type { ToolDefinition } from "./types.js";

/**
 * Every tool this server can run.
 *
 * 🔴 A HANDLER HERE IS NOT REACHABLE UNTIL `TOOL_POLICIES` DESCRIBES IT. The
 * dispatcher asks `decideTool` first and only then looks a handler up, so a
 * tool added to this list and forgotten in the policy table is dead code rather
 * than an open door. `mcp.tools.test.ts` asserts the two sets match exactly in
 * both directions, so "forgotten" fails the build rather than shipping.
 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  ...helpTools,
  ...readinessTools,
  ...clientTools,
  ...calendarTools,
  ...waitlistTools,
  ...businessTools,
  ...integrationTools,
];

const BY_NAME = new Map(TOOL_DEFINITIONS.map((t) => [t.name, t]));

export function toolDefinition(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name);
}

export * from "./types.js";
