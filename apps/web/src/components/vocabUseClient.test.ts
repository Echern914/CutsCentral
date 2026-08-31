import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 🔴 Every module that CALLS a hook from VocabProvider must itself be a client
 * module.
 *
 * VocabProvider is "use client", so its function exports (useVocab, cap) are
 * client references. A server component may render <VocabProvider> as JSX, but
 * INVOKING useVocab()/cap() during a server render throws at REQUEST time -
 * "It's not possible to invoke a client function from the server" - and the
 * nearest error boundary swallows the whole page.
 *
 * That is exactly how the 2026-08-31 outage happened: ReferralCard and
 * BarberHome called useVocab() without "use client", and every dashboard home
 * (owner and barber alike) rendered "Something went wrong" in production.
 * Nothing in the build can catch it - /dashboard is dynamic so it never
 * prerenders, `ignoreBuildErrors` mutes tsc, and it is not a type error
 * anyway. So the invariant is pinned here instead.
 */

const WEB_SRC = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** Strip comments so a mention in prose (like the layout's) does not count. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("vocabulary hooks only run in client modules", () => {
  it("every file calling useVocab() or cap() from VocabProvider says \"use client\"", () => {
    const offenders: string[] = [];
    for (const file of walk(WEB_SRC)) {
      const raw = readFileSync(file, "utf8");
      if (!raw.includes("@/components/VocabProvider")) continue;
      const code = stripComments(raw);
      // Only files that INVOKE a client function are required to be client
      // modules; rendering <VocabProvider> as JSX from a server layout is fine.
      const invokes = /\buseVocab\s*\(|\bcap\s*\(/.test(code);
      if (!invokes) continue;
      const isClient = /^\s*["']use client["']/m.test(raw.slice(0, 500));
      if (!isClient) offenders.push(file.slice(WEB_SRC.length));
    }
    // A failure here is a PRODUCTION 500 on whatever page renders the file.
    expect(offenders).toEqual([]);
  });

  it("the guard itself still sees the real consumers (not a silently empty walk)", () => {
    const consumers = walk(WEB_SRC).filter((f) =>
      readFileSync(f, "utf8").includes("@/components/VocabProvider"),
    );
    expect(consumers.length).toBeGreaterThan(10);
  });
});
