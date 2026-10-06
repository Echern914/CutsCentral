import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 🔴 AUTO-FILL COSTS NOTHING TO RUN.
 *
 * It is sold as the free assistant that keeps the book full: rules, not a
 * model. The SMS receptionist is the one AI surface that costs money, and the
 * Premium AI tier pays for it. The web assistant's cost boundary
 * (costBoundary.test.ts) only scans its own directory, so this one scans the
 * engine's own files for anything that would quietly start spending: a model
 * provider's SDK or key, or a bare network call.
 */
const FILES = ["./autoFill.ts", "./autoFillRules.ts"];

const FORBIDDEN: { what: string; pattern: RegExp }[] = [
  { what: "a model provider SDK", pattern: /@anthropic-ai|from ["']openai["']|@google\/generative-ai|langchain/i },
  { what: "a model provider key", pattern: /ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY/ },
  { what: "a bare network call", pattern: /\bfetch\s*\(|axios|node:https?/ },
  { what: "a text message", pattern: /getMessageProvider|\.send\(\{\s*to:/ },
];

describe("the Auto-fill engine", () => {
  for (const file of FILES) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    for (const { what, pattern } of FORBIDDEN) {
      it(`${file} contains no ${what}`, () => {
        expect(source).not.toMatch(pattern);
      });
    }
  }
});
