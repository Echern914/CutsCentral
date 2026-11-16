import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 🔴 `subtle` CARRIES ITS OWN ALPHA. The hairline colour is
 * `rgb(var(--cb-fg) / var(--cb-border-a))` (tailwind.config.ts), so an opacity
 * modifier does not soften it: `border-subtle/60` REPLACES that alpha with 60%
 * of the text colour, and on the light theme a hairline meant to be ~10% ink
 * drew as a near-black rule. Every one of these was a bug, so none is allowed.
 * A stronger line is `subtle-strong`; a softer one is not a modifier away.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODIFIED = /\b(?:border|divide|ring|outline)-subtle(?:-strong)?\/\d+/g;

function offenders(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        for (const m of readFileSync(path, "utf8").match(MODIFIED) ?? []) {
          found.push(`${relative(SRC, path)}: ${m}`);
        }
      }
    }
  };
  walk(SRC);
  return found;
}

describe("the subtle hairline", () => {
  it("🔴 is never given an opacity modifier, which would replace its own alpha", () => {
    expect(offenders()).toEqual([]);
  });

  it("the pattern catches the forms that drew the dark rules", () => {
    for (const cls of ["border-subtle/60", "divide-subtle/60", "hover:border-subtle/80", "border-t border-subtle/50"]) {
      expect(cls.match(MODIFIED), cls).not.toBeNull();
    }
    expect("border-subtle border-subtle-strong divide-subtle".match(MODIFIED)).toBeNull();
  });
});
