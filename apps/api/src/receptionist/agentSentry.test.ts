import type Anthropic from "@anthropic-ai/sdk";
import { randomToken } from "@chairback/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setModelClientForTests,
  runAgentTurn,
  type ReceptionistModelClient,
} from "./agent.js";

/**
 * The receptionist's tool-throw catch is the ONE booking-path failure with no
 * 500 and no user-facing error - the texter just never gets booked. The
 * unmapped-chair outage sat exactly there, invisible, because its only trace
 * was a log line. This pins that the catch now REPORTS (captureError) as well
 * as logs, and that reporting did not change the outcome the customer sees.
 */

const captureError = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureError }));

function toolUseMsg(name: string): Anthropic.Messages.Message {
  return {
    id: `msg_${randomToken(6)}`,
    type: "message",
    role: "assistant",
    model: "scripted",
    content: [{ type: "tool_use", id: `tu_${randomToken(6)}`, name, input: {} }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Messages.Message;
}

function textMsg(text: string): Anthropic.Messages.Message {
  return {
    id: `msg_${randomToken(6)}`,
    type: "message",
    role: "assistant",
    model: "scripted",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Messages.Message;
}

function scripted(responses: Anthropic.Messages.Message[]): ReceptionistModelClient {
  const queue = [...responses];
  return {
    async create() {
      const next = queue.shift();
      if (!next) throw new Error("scripted model exhausted");
      return next;
    },
  };
}

afterEach(() => {
  __setModelClientForTests(null);
  captureError.mockClear();
});

describe("a tool that throws mid-turn", () => {
  it("reports to Sentry with the tool name, and the turn still completes gracefully", async () => {
    __setModelClientForTests(
      scripted([toolUseMsg("book_appointment"), textMsg("sorry, something went wrong on my end")]),
    );
    const boom = new Error("tools.ts missed one");

    const outcome = await runAgentTurn({
      system: "sys",
      messages: [{ role: "user", content: "book me in" }],
      tools: [],
      executeTool: async () => {
        throw boom;
      },
    });

    // Reported - the exact error, named by tool, exactly once.
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledWith(boom, { tool: "book_appointment" });

    // And the customer-facing behaviour is unchanged: the model got a tool
    // failure, not a crash, and the turn resolved to a normal reply.
    expect(outcome.kind).toBe("reply");
    expect(outcome.toolCalls[0]).toMatchObject({
      name: "book_appointment",
      result: "internal error running this tool",
      isError: true,
    });
  });

  it("a tool that succeeds reports nothing", async () => {
    __setModelClientForTests(scripted([toolUseMsg("get_services"), textMsg("here you go")]));
    const outcome = await runAgentTurn({
      system: "sys",
      messages: [{ role: "user", content: "what do you offer?" }],
      tools: [],
      executeTool: async () => ({ result: "cuts", isError: false }),
    });
    expect(outcome.kind).toBe("reply");
    expect(captureError).not.toHaveBeenCalled();
  });
});
