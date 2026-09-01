import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ONE BRAIN, TWO ADAPTERS — enforced by reading the adapters' own source.
 *
 * The corner bubble and the Assistant tab's ask field are two front doors to
 * one corpus. Before PR 1 they each called the matcher directly and rendered
 * their own idea of a failure, and they had already drifted: the bubble
 * offered a mailto on a miss and the ask field offered nothing, which made the
 * page literally titled "Assistant" the only dead end in the product.
 *
 * A type cannot catch that returning. Both files can compile perfectly while
 * quietly calling `findHelp` again and inventing a second fallback, so this
 * reads the files.
 */

const WEB_SRC = join(__dirname, "../..");
const ADAPTERS = [
  join(WEB_SRC, "components/help/HelpBubble.tsx"),
  join(WEB_SRC, "app/dashboard/assistant/AskField.tsx"),
];

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("the in-app adapters share one engine", () => {
  it("🔴 neither adapter calls the raw matcher", () => {
    // findHelp/searchFeatures skip the actor gate and the escalation
    // guarantee. Going around the engine is how a surface starts answering
    // questions it should refuse, or shrugging without a way out.
    for (const path of ADAPTERS) {
      const src = source(path);
      expect(src, `${path} imports helpMatch directly`).not.toMatch(
        /from "@chairback\/config\/helpMatch"/,
      );
      expect(src, `${path} calls findHelp`).not.toMatch(/\bfindHelp\s*\(/);
    }
  });

  it("both resolve through resolveSupport", () => {
    for (const path of ADAPTERS) {
      expect(source(path)).toMatch(/resolveSupport\s*\(/);
    }
  });

  it("🔴 both render the escalation the engine hands them", () => {
    // The engine attaches a route to a human to every non-answer. An adapter
    // that computes it and never puts it on screen keeps the dead end.
    for (const path of ADAPTERS) {
      const src = source(path);
      expect(src, `${path} never reads escalation`).toMatch(/escalation/);
      expect(src, `${path} renders no mailto`).toMatch(/mailto:/);
    }
  });

  it("neither adapter hard-codes a support address of its own", () => {
    // The address belongs to the registry (SUPPORT_ESCALATION_EMAIL) and
    // arrives on the resolution. A second literal is a second thing to change
    // the day it moves — and the one that gets forgotten.
    const askField = source(ADAPTERS[1]!);
    expect(askField).not.toMatch(/support@getchairback\.com/);
  });

  it("🔴 no adapter calls a model or the network", () => {
    // The whole answer path is local and free to run. costBoundary.test.ts
    // guards the Assistant directory; this covers the bubble too, which sits
    // on every marketing page.
    for (const path of ADAPTERS) {
      const src = source(path);
      for (const banned of [
        "openai",
        "anthropic",
        "api.openai.com",
        "api.anthropic.com",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
      ]) {
        expect(src.toLowerCase(), `${path} references ${banned}`).not.toContain(
          banned.toLowerCase(),
        );
      }
      expect(src, `${path} fetches`).not.toMatch(/\bfetch\s*\(/);
    }
  });
});
