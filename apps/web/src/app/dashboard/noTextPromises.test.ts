import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Texting is off and staying off (2026-11-08), so an owner must not read that
 * ChairBack texts their clients. These three pages are server-fetching or need
 * a full shop to render, so this pins the exact sentences that were wrong.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

const RETIRED: readonly (readonly [file: string, phrase: string])[] = [
  ["_components/WinbackPreview.tsx", "automatically text"],
  ["_components/WinbackPreview.tsx", "won't be texted"],
  ["_components/WinbackPreview.tsx", "no texts are sent"],
  ["promotions/page.tsx", "text them out"],
  ["nudges/page.tsx", "rebook&rdquo; texts"],
];

describe("owner pages don't promise a text", () => {
  it.each(RETIRED)("%s no longer says %j", (file, phrase) => {
    expect(readFileSync(join(HERE, file), "utf8")).not.toContain(phrase);
  });
});
