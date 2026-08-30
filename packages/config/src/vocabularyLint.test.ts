import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The source-scan guard: barbershop words must not be hard-coded into a
 * presentation path.
 *
 * WHY A SOURCE SCAN AND NOT ONLY A RENDER SCAN. The render tests
 * (`vocabulary.regression`, `readiness.test`) prove the CENTRALIZED corpora
 * resolve correctly, but they can only see strings that a fixture happens to
 * render. Half this product's copy lives inline in a `.tsx` that no fixture
 * mounts, and "No barber has any weekly hours" survived a render scan for
 * exactly that reason - it only appears when nobody has hours.
 *
 * HOW IT FAILS SAFE IN BOTH DIRECTIONS. Every remaining hit must appear in
 * `ALLOWED` below. A NEW hit fails ("hard-coded vocabulary"), and a hit that has
 * been fixed but not removed from the list ALSO fails ("stale allowlist entry").
 * The list can therefore only ever shrink deliberately - the same shape as the
 * CTA destination manifest in readiness.test.ts.
 *
 * This lives in packages/config because that suite is node-environment and fast,
 * and it can walk the repo from here without dragging jsdom into the scan.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");

/**
 * The words that mean "barbershop" and nothing else.
 *
 * "cut" is deliberately ABSENT: it is an ordinary English verb ("cut off",
 * "haircut" is covered separately) and scanning for it produces far more noise
 * than signal. `haircut` and `lineup` carry the vertical on their own.
 */
const LEXEMES = /\b(barbers?|barbershops?|chairs?|haircuts?|clippers?)\b/i;

/** Presentation roots. Everything here renders to a customer or a shop owner. */
const ROOTS = [
  join("apps", "web", "src", "app", "dashboard"),
  join("apps", "web", "src", "app", "book"),
  join("apps", "web", "src", "app", "s"),
  join("apps", "web", "src", "app", "r"),
  join("apps", "web", "src", "components"),
  join("apps", "mobile", "app"),
  join("apps", "mobile", "src"),
];

/**
 * Paths excluded wholesale, each for a stated reason.
 *
 * 🔴 Every entry here is a claim that the barbershop wording inside is CORRECT,
 * not merely tolerated. Adding one is a decision, not a convenience.
 */
const EXCLUDED_PATHS: { match: (rel: string) => boolean; why: string }[] = [
  {
    match: (p) => /\.test\.tsx?$/.test(p) || p.includes("__fixtures__"),
    why: "Tests and fixtures name barbershops on purpose - that is the point of a fixture.",
  },
  {
    // 🔴 DEFERRED, NOT EXEMPT. Walk-in merged with both gates false and has
    // never run in production, so its copy is deliberately untouched until it
    // is enabled and a real shop uses it. Deleting this entry is the whole of
    // that follow-up PR's scope, which is why it is named rather than folded
    // into the general exclusions above.
    match: (p) =>
      /(^|[\\/])(kiosk|line)([\\/]|$)/.test(p) ||
      /walkin/i.test(p) ||
      /WalkIn/.test(p) ||
      /BarberWalkIns/.test(p),
    why: "DEFERRED_TO_WALK_IN_PR - walk-in is dark and unproven in production.",
  },
];

/**
 * Individual remaining hits, keyed `<relative path>:<lowercased lexeme>`.
 *
 * 🔴 Every entry is a claim that the word is CORRECT there, with the reason
 * written down. This list may only ever shrink - see the stale-entry test.
 */
const ALLOWED: Record<string, string> = {
  // -- Wire values, not copy -----------------------------------------------
  // These are strings, so the scan sees them, but nothing renders them to a
  // human. Renaming any of them is a breaking change for zero user benefit.
  "apps/mobile/app/_layout.tsx:barber":
    "expo-router screen NAME - the /barber route. Renaming breaks every deep link.",
  "apps/mobile/app/index.tsx:barber":
    "`mode: \"barber\"` - the persisted Mode union, stored under cb.mode.",
  "apps/mobile/src/joinAuth.ts:barber":
    "Writes the persisted Mode value; must match mode.ts exactly.",
  "apps/mobile/src/mode.ts:barber":
    "The Mode union's own type guard.",
  "apps/mobile/src/push.ts:barber":
    "The /api/barber/push/native ROUTE PATH. Server-side contract.",
  "apps/web/src/app/dashboard/assistant/readiness.ts:barber":
    "`scope: \"barber\"` and the role union - the readiness wire shape, matching ReadinessRole on the API.",

  // -- Correct barbershop-specific copy -------------------------------------
  "apps/web/src/components/marketing/Landing.tsx:barbershops":
    "The homepage stays barber-first on purpose - it is the beachhead, and the vertical pages carry the rest.",
  "apps/web/src/components/marketing/Landing.tsx:chair":
    "Same: barber-first homepage copy.",
  "apps/web/src/components/marketing/PunchCardDemo.tsx:chair":
    "The homepage's punch-card demo, showing a barbershop card. Barber-first marketing.",
  "apps/web/src/components/marketing/Testimonials.tsx:chair":
    "\"From the chair\" - a barbershop testimonial section on the barber-first homepage.",

  // -- Demo fixtures ---------------------------------------------------------
  "apps/web/src/app/book/manage/[token]/ManageClient.tsx:chair":
    "Demo-tour sample nudge text. The demo shop IS a barbershop.",
};

interface Hit {
  key: string;
  rel: string;
  line: number;
  text: string;
}

/** Every .ts/.tsx under a root, skipping node_modules and build output. */
function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Strip comments, imports and the things that LOOK like copy but are not.
 *
 * The scan is intentionally line-based and blunt. It over-reports rather than
 * under-reports, and the allowlist is where a false positive gets adjudicated
 * once, in writing, instead of being silently regex'd away here.
 */
function isScannable(line: string): boolean {
  const t = line.trim();
  if (t === "") return false;
  // Comments: developer-facing, and frequently ABOUT the vocabulary work.
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
  // Imports and module paths.
  if (t.startsWith("import ") || t.startsWith("export ") || t.includes("from \"")) return false;
  return true;
}

/**
 * Strip whole comment BLOCKS before scanning, tracking state across lines.
 *
 * A line-at-a-time check cannot see the middle of a wrapped comment - a JSX
 * `{/* ... *\/}` continuation line has no leading marker at all and reads
 * exactly like prose. That produced ~150 false positives on the first run, which
 * is the fastest way to make a guard like this get switched off.
 */
function stripCommentBlocks(src: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split(/\r?\n/)) {
    let text = line;
    if (inBlock) {
      const end = text.indexOf("*/");
      if (end === -1) {
        out.push("");
        continue;
      }
      text = text.slice(end + 2);
      inBlock = false;
    }
    // Consume any complete /* ... */ pairs on this line, then detect an opener.
    let guard = 0;
    for (;;) {
      if (guard++ > 50) break;
      const open = text.indexOf("/*");
      if (open === -1) break;
      const close = text.indexOf("*/", open + 2);
      if (close === -1) {
        text = text.slice(0, open);
        inBlock = true;
        break;
      }
      text = text.slice(0, open) + " " + text.slice(close + 2);
    }
    // Trailing line comments: `if (!w) continue; // the barber's regular hours`.
    // A leading `//` is already handled by isScannable; this catches the ones
    // that sit after code, which are just as developer-facing.
    const lineComment = text.indexOf("//");
    if (lineComment !== -1 && !/https?:$/.test(text.slice(0, lineComment))) {
      text = text.slice(0, lineComment);
    }
    // JSX comment openers `{/*` are handled by the same pairing above.
    out.push(text);
  }
  return out;
}

/**
 * Remove the non-copy occurrences of the lexemes, so what remains is prose.
 *
 * Order matters: the product name and route paths are stripped BEFORE the word
 * scan, because "ChairBack" and "/dashboard/booking" both contain "chair".
 */
/**
 * Keep only the parts of a line that a HUMAN reads: string literals and JSX
 * text. Everything else on the line is code.
 *
 * This is what makes the scan about copy rather than about the word "chair"
 * appearing anywhere. Without it, `data.chair`, `barbers: string;` and
 * `const barber = detail?.staffName` all read as barbershop copy - they are a
 * property access, a type and a local variable, and renaming them would change
 * nothing a customer sees while churning half the codebase.
 */
function copyTextOnly(line: string): string {
  const parts: string[] = [];
  // Quoted strings, including template literals. Escapes are not handled
  // exhaustively; over-capturing here is safe because the result is only ever
  // searched for whole words.
  for (const m of line.matchAll(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`/g)) {
    // Drop `${...}` interpolations: those are CODE inside a string. Without
    // this, `${data.chair.name}` and `${vocab.stationNoun}` both read as
    // barbershop copy - one is a property access and the other is the fix.
    parts.push(m[0].replace(/\$\{[^}]*\}/g, " "));
  }
  // JSX text nodes: the run between a `>` and the next `<`.
  for (const m of line.matchAll(/>([^<>{}]+)</g)) parts.push(m[1] ?? "");
  // A JSX text node that wraps across lines has no `>` or `<` on its own line.
  // Treat a line with no code punctuation as prose.
  if (parts.length === 0 && !/[<>{}();=]/.test(line)) parts.push(line);
  return parts.join(" ");
}

function stripNonCopy(line: string): string {
  return (
    copyTextOnly(line)
      // The product name and its domain - inventory only, never renamed.
      .replace(/ChairBack/g, "")
      .replace(/chairback/gi, "")
      .replace(/getchairback\.com/g, "")
      // Identifiers: barberId, staffId, BarberHome, chairScope, useBarber...
      .replace(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:[Bb]arber|[Cc]hair)[A-Za-z0-9_$]*\b/g, "")
      .replace(/\b(?:barber|chair)[A-Z][A-Za-z0-9_$]*\b/g, "")
      // The BARBER seat role - an authorization wire value, never presentation.
      .replace(/\bBARBER\b/g, "")
      // Route paths and URLs.
      .replace(/["'`]\/[^"'`]*["'`]/g, "")
      .replace(/https?:\/\/\S+/g, "")
      // CSS/motion tokens that merely contain a lexeme substring.
      .replace(/\b[a-z-]*fade[a-z-]*\b/gi, "")
  );
}

function collectHits(): Hit[] {
  const hits: Hit[] = [];
  for (const root of ROOTS) {
    for (const file of walk(join(REPO, root))) {
      const rel = relative(REPO, file).split(sep).join("/");
      if (EXCLUDED_PATHS.some((e) => e.match(rel))) continue;
      const lines = stripCommentBlocks(readFileSync(file, "utf8"));
      lines.forEach((line, i) => {
        if (!isScannable(line)) return;
        const cleaned = stripNonCopy(line);
        const m = cleaned.match(LEXEMES);
        if (!m) return;
        hits.push({
          key: `${rel}:${m[0].toLowerCase()}`,
          rel,
          line: i + 1,
          text: line.trim().slice(0, 140),
        });
      });
    }
  }
  return hits;
}

describe("no hard-coded barbershop vocabulary in a presentation path", () => {
  const hits = collectHits();

  it("every remaining hit is on the allowlist, with a reason", () => {
    const unexpected = hits.filter((h) => !(h.key in ALLOWED));
    // The message is the useful part: it names the file, the line and the text,
    // so a failure is actionable without re-running anything.
    const detail = unexpected
      .map((h) => `  ${h.rel}:${h.line}  ${h.text}`)
      .join("\n");
    expect(
      unexpected.length,
      unexpected.length === 0
        ? ""
        : `Hard-coded vocabulary in ${unexpected.length} place(s).\n` +
          `Resolve it through the shop's vocabulary, or add it to ALLOWED with a reason:\n${detail}`,
    ).toBe(0);
  });

  it("the allowlist has no stale entries", () => {
    // 🔴 The half that makes the list shrink. Without this, a fixed string
    // leaves its exemption behind and the next hard-coded word slips in under
    // an entry that no longer describes anything.
    const present = new Set(hits.map((h) => h.key));
    const stale = Object.keys(ALLOWED).filter((k) => !present.has(k));
    expect(
      stale.length,
      stale.length === 0 ? "" : `Stale ALLOWED entries - delete them:\n  ${stale.join("\n  ")}`,
    ).toBe(0);
  });

  it("scans a meaningful number of files (the walk is not silently empty)", () => {
    // A broken path would make every assertion above pass by finding nothing,
    // which is the failure mode a scan like this dies of.
    const scanned = ROOTS.flatMap((r) => walk(join(REPO, r)));
    expect(scanned.length).toBeGreaterThan(50);
  });
});

describe("business type never reaches an access decision", () => {
  /**
   * 🔴 The product boundary, turned into a mechanical check.
   *
   * Business type controls language, recommendations and defaults. It must never
   * control authorization, billing, entitlement or tenancy - so the words simply
   * do not appear in the modules that decide those things.
   */
  const FORBIDDEN_IN = [
    join("apps", "api", "src", "billing"),
    join("apps", "api", "src", "middleware"),
  ];

  it("no billing or middleware module reads industry or businessType", () => {
    const offenders: string[] = [];
    for (const root of FORBIDDEN_IN) {
      for (const file of walk(join(REPO, root))) {
        const rel = relative(REPO, file).split(sep).join("/");
        if (/\.test\.tsx?$/.test(rel)) continue;
        // mcpAuth reads the columns ONLY to build presentation vocabulary for
        // `initialize.instructions`; it is excluded by name rather than by a
        // pattern so the exemption stays visible.
        if (rel.endsWith("middleware/mcpAuth.ts")) continue;
        const src = readFileSync(file, "utf8");
        const code = src
          .split(/\r?\n/)
          .filter(isScannable)
          .join("\n");
        if (/\b(industry|businessType)\b/.test(code)) offenders.push(rel);
      }
    }
    expect(
      offenders.length,
      offenders.length === 0
        ? ""
        : `Business type reached an access-control module:\n  ${offenders.join("\n  ")}`,
    ).toBe(0);
  });

  it("🔴 no client component imports the SERVER-only vocabulary helpers", () => {
    /**
     * `@/lib/vocab` reads `getMe()`, which reaches `next/headers`. A "use
     * client" file importing anything from it - even a one-line `capitalize` -
     * drags the server API client into the client bundle and fails `next build`
     * with a message about `pages/`, which points nowhere near the real cause.
     *
     * Client components use `cap`/`useVocab` from `@/components/VocabProvider`
     * instead. TYPECHECK DOES NOT CATCH THIS; only the build does, which is why
     * it is worth a test that names it.
     */
    const offenders: string[] = [];
    for (const root of [join("apps", "web", "src")]) {
      for (const file of walk(join(REPO, root))) {
        const src = readFileSync(file, "utf8");
        if (!/^\s*["']use client["']/m.test(src.split("\n").slice(0, 3).join("\n"))) continue;
        if (/from ["']@\/lib\/vocab["']/.test(src)) {
          offenders.push(relative(REPO, file).split(sep).join("/"));
        }
      }
    }
    expect(
      offenders.length,
      offenders.length === 0
        ? ""
        : `Client components importing @/lib/vocab (use @/components/VocabProvider):\n  ${offenders.join("\n  ")}`,
    ).toBe(0);
  });

  it("the MCP tool policy matrix does not branch on business type", () => {
    const policy = readFileSync(
      join(REPO, "apps", "api", "src", "mcp", "toolPolicy.ts"),
      "utf8",
    );
    const code = policy.split(/\r?\n/).filter(isScannable).join("\n");
    expect(code).not.toMatch(/\b(industry|businessType|vocabulary)\b/);
  });
});
