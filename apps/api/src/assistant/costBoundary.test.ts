import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 🔴 THE BOOKING CHAT RUNS ENTIRELY INSIDE THIS API. No model, no provider
 * SDK or key, no outside service, no network call of its own - so it costs
 * nothing per message, and no machine outside the API (nobody's PC, no GPU
 * box, no tunnel) is needed for it to work. Its only I/O is the database,
 * through the same booking tools the rest of the API uses.
 */
const here = dirname(fileURLToPath(import.meta.url));
const files = [
  ...readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(here, f)),
  join(here, "..", "routes", "assistantChat.ts"),
];

describe("🔴 booking chat: no model, no outside service", () => {
  it("no provider SDK, key, model setting, or inference endpoint", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/from\s+["'](openai|@anthropic-ai\/sdk|@google\/generative-ai|groq-sdk|@mistralai\/[^"']+|cohere-ai|ollama)["']/);
      expect(src, f).not.toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|GROQ_API_KEY|OLLAMA|RECEPTIONIST_MODEL/);
      expect(src, f).not.toMatch(/chat\/completions|\/v1\/messages|\/api\/chat|\/api\/generate/);
    }
  });

  it("makes no network call of its own", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect((src.match(/\bfetch\(|axios|https?\.request\(|new WebSocket/g) ?? []).length, f).toBe(0);
    }
  });

  it("the only switch is ASSISTANT_CHAT_ENABLED, and it defaults OFF", () => {
    const env = readFileSync(join(here, "..", "..", "..", "..", "packages", "config", "src", "env.ts"), "utf8");
    expect(env).toMatch(/ASSISTANT_CHAT_ENABLED: boolish\.default\("false"\)/);
    expect(env).not.toMatch(/OLLAMA_BASE_URL|ASSISTANT_MODEL|ASSISTANT_INFERENCE/);
  });
});
