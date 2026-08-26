import { prisma, type McpAuditResult, type McpOperationType } from "@chairback/db";
import { logger } from "../logger.js";

/**
 * The MCP audit trail.
 *
 * 🔴 WHAT MUST NEVER REACH THIS TABLE. No client names, phone numbers, emails,
 * appointment notes, message bodies, model prompts, tool arguments or response
 * bodies. A resource is named by TYPE and ID only. The table is meant to be
 * readable by support and renderable in the dashboard without becoming a second,
 * less-guarded copy of the customer database - and `failureCode` is a short
 * machine string for the same reason (never a message, never a stack, never
 * anything derived from the request body).
 *
 * 🔴 WRITING AN AUDIT ROW MUST NEVER FAIL A REQUEST. If the insert throws, we
 * log and carry on. The alternative - a barber's assistant breaking because an
 * audit write timed out - trades a real outage for a bookkeeping gap.
 */

export interface AuditInput {
  shopId: string;
  userId?: string | null;
  connectionId?: string | null;
  toolName: string;
  operationType?: McpOperationType;
  resourceType?: string | null;
  resourceId?: string | null;
  result: McpAuditResult;
  failureCode?: string | null;
}

/**
 * `failureCode` is constrained to a short slug so a caller cannot smuggle a
 * message (or user input) into the audit trail by accident.
 */
const FAILURE_CODE_RE = /^[a-z0-9_]{1,40}$/;

export async function logMcpEvent(input: AuditInput): Promise<void> {
  const failureCode =
    input.failureCode && FAILURE_CODE_RE.test(input.failureCode) ? input.failureCode : null;
  try {
    await prisma.mcpAuditEvent.create({
      data: {
        shopId: input.shopId,
        userId: input.userId ?? null,
        connectionId: input.connectionId ?? null,
        toolName: input.toolName.slice(0, 80),
        operationType: input.operationType ?? "READ",
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        result: input.result,
        failureCode,
      },
    });
  } catch (err) {
    // Deliberately does not rethrow. Logged WITHOUT the input, which could
    // carry ids we would rather not duplicate into stdout.
    logger.warn({ mcpAudit: true, err: (err as Error).message }, "mcp audit write failed");
  }
}

/** An authorization-lifecycle event (consent, token, revoke). */
export async function logMcpAuth(
  input: Omit<AuditInput, "operationType">,
): Promise<void> {
  await logMcpEvent({ ...input, operationType: "AUTH" });
}
