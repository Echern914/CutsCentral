import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 🔴 THE COST BOUNDARY.
 *
 * ChairBack must never pay for the Assistant's model usage. The design that
 * delivers that is: the barber connects their OWN ChatGPT or Claude account
 * over MCP, their provider bills them under their own plan, and ChairBack
 * supplies only tools and destinations. Everything in this PR answers from data
 * already on the device — the hand-written help corpus and the readiness engine
 * — so nothing here calls a model at all.
 *
 * That is a promise a comment cannot keep. This test reads the Assistant's own
 * source and fails if a model provider ever appears in it: an API key, a
 * provider host, an SDK import, or a credit ledger. It is deliberately a
 * SOURCE-level check rather than a runtime one, because the failure it guards
 * against is somebody adding a "quick fallback to GPT when the corpus misses",
 * which would be a real ChairBack bill on every miss and would look perfectly
 * innocent at runtime until the invoice arrived.
 *
 * NOTE ON SCOPE: ChairBack does pay Anthropic for the SMS receptionist, which
 * is a separate, metered, opt-in product with its own entitlement. This test
 * pins the ASSISTANT surface only — that is exactly the line the business
 * requirement draws.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /\bopenai\b/i, why: "an OpenAI dependency would be ChairBack-funded model usage" },
  {
    pattern: /@anthropic-ai\/sdk|api\.anthropic\.com/i,
    why: "an Anthropic SDK/endpoint would be ChairBack-funded model usage",
  },
  { pattern: /api\.openai\.com/i, why: "a direct model endpoint" },
  { pattern: /OPENAI_API_KEY|ANTHROPIC_API_KEY/i, why: "a model provider key" },
  {
    pattern: /\bai[_-]?credits?\b|creditBalance|deductCredits/i,
    why: "an AI-credit wallet is explicitly out of scope",
  },
  {
    pattern: /chat\/completions|\/v1\/messages\b/i,
    why: "a model completion call",
  },
];

function sources(): { name: string; text: string }[] {
  return readdirSync(HERE)
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.endsWith(".test.ts"))
    .map((f) => ({ name: f, text: readFileSync(join(HERE, f), "utf8") }));
}

describe("the Assistant never spends ChairBack's money on a model", () => {
  it("has source files to check (the guard cannot pass vacuously)", () => {
    const names = sources().map((s) => s.name);
    expect(names).toContain("page.tsx");
    expect(names).toContain("AskField.tsx");
    expect(names.length).toBeGreaterThanOrEqual(3);
  });

  it("names no model provider, endpoint, key or credit ledger", () => {
    for (const { name, text } of sources()) {
      // Strip comments: this file's own prose, and the page's explanation of
      // the arrangement, legitimately say "ChatGPT" and "Claude" to the reader.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const { pattern, why } of FORBIDDEN) {
        expect(pattern.test(code), `${name} contains ${pattern} — ${why}`).toBe(false);
      }
    }
  });

  it("makes no outbound request of its own", () => {
    for (const { name, text } of sources()) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      // Every read goes through the app's own API client, which talks only to
      // ChairBack's API. A bare fetch()/axios here would be a new egress path
      // that nothing else in the dashboard has.
      expect(/\bfetch\s*\(/.test(code), `${name} calls fetch() directly`).toBe(false);
      expect(/\baxios\b/.test(code), `${name} imports axios`).toBe(false);
    }
  });

  // The tab has to be worth opening with nothing connected — otherwise the AI
  // is load-bearing, which is the arrangement this whole design avoids.
  it("says plainly that the barber's own provider bills them, not ChairBack", () => {
    // 🔴 Checked across the WHOLE surface, not one file. The copy started in
    // page.tsx and moved into ConnectionPanel.tsx when the panel became real;
    // pinning it to a single filename would have made a refactor look like a
    // removed disclosure, and the obvious "fix" is to delete the assertion.
    // What matters is that the surface says it somewhere, so that is what is
    // asserted. JSX wraps the copy across lines, so the text is FLATTENED
    // first - otherwise reformatting breaks the test and teaches the next
    // person to delete it.
    const surface = sources()
      .map((s) => s.text)
      .join(" ")
      .replace(/\s+/g, " ");
    expect(surface).toMatch(/ChairBack never charges you for AI/i);
    expect(surface).toMatch(/does not sell or provide AI model credits/i);
    // The tab has to be worth opening with nothing connected.
    expect(surface).toMatch(/keeps working on any plan|work without a connection/i);
  });

  it("🔴 the connector panel promises READ-ONLY, and management is not offered", () => {
    // Management access is a separate opt-in that does not ship in this
    // release. The panel must not imply otherwise to a barber deciding whether
    // to connect their account.
    const panel = readFileSync(join(HERE, "ConnectionPanel.tsx"), "utf8").replace(/\s+/g, " ");
    expect(panel).toMatch(/read-only/i);
    expect(panel).toMatch(/never change or cancel anything/i);
  });
});
