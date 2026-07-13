import Anthropic from "@anthropic-ai/sdk";
import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";

/**
 * The receptionist's Anthropic tool-use loop. A MANUAL loop (not the SDK tool
 * runner) because every tool call + result must be persisted for audit, tools
 * execute against the booking engine with a per-conversation context, and any
 * failure mode must degrade to "escalate to the barber", never a crash.
 *
 * Model notes (claude-sonnet-5 default, RECEPTIONIST_MODEL overrides):
 *  - omit `thinking` (adaptive is the default) and never pass temperature/top_p
 *    (rejected with a 400 on sonnet-5)
 *  - `cache_control` on the system block: the rendered prompt is byte-stable
 *    per shop (see prompt.ts), so multi-turn conversations reuse the cache
 *  - max_tokens has headroom because adaptive thinking counts against it
 */

/** One executed tool call, exactly as persisted to ReceptionistMessage.toolCalls. */
export interface ToolCallRecord {
  name: string;
  input: unknown;
  result: string;
  isError: boolean;
}

/** What tools.ts hands back for one call. */
export interface ToolExecutionResult {
  result: string;
  isError: boolean;
}

export type ToolExecutor = (
  name: string,
  input: unknown,
) => Promise<ToolExecutionResult>;

/** The slice of the Anthropic client the loop needs - the test seam's surface. */
export interface ReceptionistModelClient {
  create(
    params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Messages.Message>;
}

let testModelClient: ReceptionistModelClient | null = null;
let realClient: Anthropic | null = null;

/** Test seam: inject a scripted model so money-path tests run with no API key. */
export function __setModelClientForTests(client: ReceptionistModelClient | null): void {
  testModelClient = client;
}

function getModelClient(): ReceptionistModelClient {
  if (testModelClient) return testModelClient;
  const apiKey = apiEnv().ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("receptionist_not_configured");
  if (!realClient) realClient = new Anthropic({ apiKey, timeout: 60_000 });
  const client = realClient;
  return {
    create: (params) => client.messages.create(params),
  };
}

/** Runaway-loop backstop: a booking exchange should never need this many calls. */
const MAX_ITERATIONS = 8;

export interface AgentTurnInput {
  system: string;
  messages: Anthropic.Messages.MessageParam[];
  tools: Anthropic.Messages.Tool[];
  executeTool: ToolExecutor;
}

export type AgentTurnOutcome =
  | { kind: "reply"; text: string; toolCalls: ToolCallRecord[] }
  | { kind: "escalate"; reason: string; toolCalls: ToolCallRecord[] };

/**
 * Run one conversational turn to completion. Executes every tool_use block the
 * model emits (results are returned in ONE user message, parallel-call safe)
 * and loops until end_turn. Anything abnormal - refusal, max_tokens, the
 * iteration cap, an API error after the SDK's retries - resolves to an
 * `escalate` outcome; the caller hands the thread to the barber.
 */
export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnOutcome> {
  const env = apiEnv();
  const client = getModelClient();
  const toolCalls: ToolCallRecord[] = [];
  // Local copy - the loop appends assistant/tool_result turns as it goes.
  const messages: Anthropic.Messages.MessageParam[] = [...input.messages];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let response: Anthropic.Messages.Message;
    try {
      response = await client.create({
        model: env.RECEPTIONIST_MODEL,
        max_tokens: 4096,
        system: [
          {
            type: "text",
            text: input.system,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: input.tools,
        messages,
      });
    } catch (err) {
      logger.error({ err }, "receptionist model call failed");
      return { kind: "escalate", reason: "model_api_error", toolCalls };
    }

    if (response.stop_reason === "refusal") {
      return { kind: "escalate", reason: "model_refusal", toolCalls };
    }
    if (response.stop_reason === "max_tokens") {
      return { kind: "escalate", reason: "model_max_tokens", toolCalls };
    }

    if (response.stop_reason === "tool_use") {
      const toolUses = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
      );
      messages.push({ role: "assistant", content: response.content });

      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const call of toolUses) {
        let executed: ToolExecutionResult;
        try {
          executed = await input.executeTool(call.name, call.input);
        } catch (err) {
          // tools.ts already catches its own errors; this is the belt-and-
          // suspenders so a bug there reads as a tool failure, not a crash.
          logger.error({ err, tool: call.name }, "receptionist tool threw");
          executed = { result: "internal error running this tool", isError: true };
        }
        toolCalls.push({
          name: call.name,
          input: call.input,
          result: executed.result,
          isError: executed.isError,
        });
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: executed.result,
          is_error: executed.isError,
        });
      }
      // ALL results in one user message (splitting them degrades parallel use).
      messages.push({ role: "user", content: results });
      continue;
    }

    if (response.stop_reason === "pause_turn") {
      // Defensive: no server tools are declared, but resume per the API contract.
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    // end_turn (or stop_sequence): the text blocks are the SMS reply.
    const text = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) {
      return { kind: "escalate", reason: "empty_reply", toolCalls };
    }
    return { kind: "reply", text, toolCalls };
  }

  return { kind: "escalate", reason: "iteration_cap", toolCalls };
}
