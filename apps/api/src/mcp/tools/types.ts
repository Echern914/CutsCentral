import type { SeatRole } from "@chairback/config";

/**
 * What a tool handler is handed, and what it may hand back.
 *
 * 🔴 THE INVOCATION IS ENTIRELY SERVER-DERIVED EXCEPT `args`. `shopId`,
 * `userId`, `role` and `chairFilterStaffId` are decided by `requireMcpAuth` and
 * `decideTool` before a handler runs. A handler that reads a shop id or a staff
 * id out of `args` has reintroduced the exact hole the barber router's header
 * comment warns about — one query parameter away from reading a colleague's
 * book — so handlers take the scope they are given and narrow no wider.
 */
export interface ToolInvocation {
  /** The raw `arguments` object from the JSON-RPC call. UNTRUSTED. */
  args: unknown;
  shopId: string;
  userId: string;
  role: SeatRole;
  /**
   * Non-null means: every query this handler makes MUST be filtered to this
   * chair. Null means whole-shop, which only a manager or owner ever gets.
   */
  chairFilterStaffId: string | null;
  /** Already enforced by the policy; passed through for tools that soften copy. */
  hasAccess: boolean;
  /** One clock for the whole call, so two queries cannot straddle midnight. */
  now: Date;
}

export interface ToolOk {
  ok: true;
  /** Serialised to the model as JSON. Must be PII-minimised by the handler. */
  data: unknown;
  /**
   * For the audit row. TYPE AND ID ONLY — never a name, never a phone number.
   * See the header of mcp/audit.ts for why the audit table is not allowed to
   * become a second copy of the customer database.
   */
  resource?: { type: string; id?: string | null };
}

export interface ToolErr {
  ok: false;
  /** Short slug. Goes to the audit trail verbatim, so `[a-z0-9_]{1,40}`. */
  code: string;
  /**
   * What the model is told.
   *
   * 🔴 A FIXED STRING PER CODE. Never interpolate the caller's arguments into
   * it: a validation message that echoes input turns the audit trail and the
   * model's context into a mirror for whatever was sent.
   */
  message: string;
}

export type ToolResult = ToolOk | ToolErr;

/**
 * A JSON Schema object, hand-written per tool.
 *
 * Hand-written rather than generated from zod: this is what an untrusted model
 * reads to decide how to call us, and it is worth being able to see exactly
 * what it says without a conversion layer in between. The zod schema inside the
 * handler is what actually enforces it.
 */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

export interface ToolDefinition {
  /** Must match a name in TOOL_POLICIES, or the tool is unreachable. */
  name: string;
  inputSchema: ToolInputSchema;
  handler: (inv: ToolInvocation) => Promise<ToolResult>;
}

/** The one refusal for arguments that do not parse. Fixed text, by design. */
export const INVALID_ARGS: ToolErr = {
  ok: false,
  code: "invalid_arguments",
  message: "Those arguments aren't valid for this tool. Check the schema and try again.",
};
