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
 * resolve correctly, but they can only see strings a fixture happens to render.
 * Much of this product's copy lives inline in a `.tsx` no fixture mounts, and
 * "No barber has any weekly hours" survived a render scan for exactly that
 * reason - it only appears when nobody has hours.
 *
 * 🔴 THE EXCEPTION CONTRACT IS OCCURRENCE-EXACT.
 *
 * An earlier version keyed exceptions on `<path>:<lexeme>`, which was far too
 * coarse: approving one "chair" in a file silently blessed every "chair" added
 * to that file afterwards. An exception now pins the PATH, the LEXEME, the
 * normalized SNIPPET it occurs in, and HOW MANY times - and the matcher
 * CONSUMES each approved occurrence once, so:
 *
 *   - a second identical approved literal in the same file FAILS;
 *   - a different literal using the same lexeme in that file FAILS;
 *   - removing an approved occurrence makes the exception STALE and FAILS;
 *   - moving unrelated lines does NOT break it (nothing keys on line numbers).
 *
 * Those four properties are proven against the matcher itself, with synthetic
 * inputs, in the "matcher contract" block below - not merely asserted here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");

/**
 * The words that carry a vertical.
 *
 * `cut`, `fade` and `lineup` are ordinary English as well as barbershop terms,
 * which is exactly why they are scanned rather than skipped: a real
 * "Free Cut unlocked" is the thing this guard exists to find, and the ordinary
 * uses are few enough to name individually in the manifest.
 */
const LEXEMES = [
  "barber",
  "barbers",
  "barbershop",
  "barbershops",
  "chair",
  "chairs",
  "haircut",
  "haircuts",
  "clipper",
  "clippers",
  "cut",
  "cuts",
  "lineup",
  "lineups",
  "line-up",
  "line-ups",
  "fade",
  "fades",
] as const;

/** Matches any lexeme as a whole word. `line-up` needs the hyphen inside. */
const LEXEME_RE = new RegExp(`(?<![\\w-])(${LEXEMES.join("|")})(?![\\w-])`, "gi");

/**
 * Presentation roots that are MECHANICALLY COVERED by this scan.
 *
 * 🔴 This list is the honest scope of the guarantee, and it is smaller than
 * "every presentation path". Deliberately OUTSIDE it today:
 *
 *   - `apps/api/src/messaging/**` - SMS, push and email templates. They resolve
 *     the visit-noun already, but the appointment/waitlist/promo builders write
 *     generic copy rather than vocabulary-driven copy, so scanning them would
 *     report style, not defects. Their correctness is covered by the render
 *     tests in `templates.test.ts` instead.
 *   - `apps/api/src/receptionist/**` and `ai/receptionist-prompt.md` - the
 *     persona template, whose `{{BARBER_NAMES}}` token names are wire values.
 *   - `packages/config/src/help.ts` and `features.ts` - ~90 barber mentions in
 *     the help corpus and feature index, NOT yet converted to vocabulary. This
 *     is the largest known gap and is named in the PR body rather than hidden
 *     behind a silent exclusion.
 *   - `apps/web/src/app/for/**`, `onboarding/**`, `terms|privacy|sms*` - the
 *     barber-first marketing beachhead and the carrier-filed legal copy.
 *
 * Adding a root here is how the guarantee grows; widening EXCLUSIONS is not.
 */
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
 * 🔴 Every entry is a claim that the barbershop wording inside is CORRECT, not
 * merely tolerated. Adding one is a decision, not a convenience.
 */
const EXCLUDED_PATHS: { match: (rel: string) => boolean; why: string }[] = [
  {
    match: (p) => /\.test\.tsx?$/.test(p) || p.includes("__fixtures__"),
    why: "Tests and fixtures name barbershops on purpose - that is the point of a fixture.",
  },
  {
    // 🔴 DEFERRED, NOT EXEMPT. Walk-in merged with both gates false and has
    // never run in production, so its copy is deliberately untouched until it
    // is enabled and a real shop uses it. Deleting this ONE entry is the whole
    // of that follow-up PR's scope, which is why it is named rather than folded
    // into the general exclusions above.
    match: (p) =>
      /(^|[\\/])(kiosk|line)([\\/]|$)/.test(p) ||
      /walkin/i.test(p) ||
      /WalkIn/.test(p) ||
      /BarberWalkIns/.test(p),
    why: "DEFERRED_TO_WALK_IN_PR - walk-in is dark and unproven in production.",
  },
];

/** One approved occurrence set. Path + lexeme + snippet + count + reason. */
interface Exception {
  /** Repo-relative, forward slashes. */
  path: string;
  /** Lowercased lexeme this exception covers. */
  lexeme: string;
  /**
   * The normalized copy segment the lexeme occurs in - see `normalize`.
   * Whitespace-collapsed and trimmed, so reindenting does not invalidate it,
   * but CHANGING THE WORDS does (and should).
   */
  snippet: string;
  /** How many times this exact (path, lexeme, snippet) triple may occur. */
  count: number;
  why: string;
}

/**
 * 🔴 THE MANIFEST. Every approved occurrence, counted.
 *
 * Ordinary-English uses of `cut`/`fade`/`lineup` live here too: they are not
 * silently stripped by the scanner, because a regex broad enough to skip them
 * is broad enough to skip a real defect.
 */
const ALLOWED: Exception[] = [
  // ---- ROUTE PATHS --------------------------------------------------------
  // Deliberately NOT stripped wholesale by the scanner: a NEW barber-named
  // route should have to be looked at, so each existing one is named here.
  {
    path: "apps/mobile/app/join.tsx",
    lexeme: "barber",
    snippet: '"/barber"',
    count: 1,
    why: "expo-router destination for the owner tab. Renaming breaks every deep link already in the wild.",
  },
  {
    path: "apps/mobile/app/login.tsx",
    lexeme: "barber",
    snippet: '"/barber"',
    count: 4,
    why: "The same expo-router destination, on the four post-login branches (password, Google, Apple, handoff).",
  },
  {
    path: "apps/mobile/src/CallbackScreen.tsx",
    lexeme: "barber",
    snippet: '"/barber"',
    count: 1,
    why: "expo-router destination after the OAuth callback resolves.",
  },
  {
    path: "apps/mobile/src/push.ts",
    lexeme: "barber",
    snippet: "` /api/barber/push/native`",
    count: 1,
    why: "The push-registration ROUTE PATH on the API. A server-side contract, not copy.",
  },
  {
    path: "apps/web/src/app/dashboard/_components/barberClientActions.ts",
    lexeme: "barber",
    snippet: "`/api/barber/clients?q= `",
    count: 1,
    why: "API route path for the own-chair client search.",
  },
  {
    path: "apps/web/src/app/dashboard/_components/barberClientActions.ts",
    lexeme: "barber",
    snippet: '"/api/barber/clients"',
    count: 1,
    why: "API route path for the own-chair client list.",
  },
  {
    path: "apps/web/src/app/dashboard/_components/barberClientActions.ts",
    lexeme: "barber",
    snippet: "`/api/barber/clients/ /rewards-link`",
    count: 1,
    why: "API route path for texting a client their rewards link.",
  },
  {
    path: "apps/web/src/app/dashboard/page.tsx",
    lexeme: "barber",
    snippet: "`/api/barber/home?from= &to= `",
    count: 1,
    why: "API route path for the own-chair home payload.",
  },

  // ---- Wire values that happen to be string literals ----------------------
  {
    path: "apps/mobile/app/_layout.tsx",
    lexeme: "barber",
    snippet: '"barber"',
    count: 1,
    why: "expo-router screen NAME for the /barber route. Renaming breaks every deep link.",
  },
  {
    path: "apps/mobile/app/index.tsx",
    lexeme: "barber",
    snippet: '"barber"',
    count: 1,
    why: 'mode: "barber" - the persisted Mode union, stored under the cb.mode key.',
  },
  {
    path: "apps/mobile/src/joinAuth.ts",
    lexeme: "barber",
    snippet: '"barber"',
    count: 1,
    why: "Writes the persisted Mode value; must match mode.ts exactly or the shell opens the wrong tab.",
  },
  {
    path: "apps/mobile/src/mode.ts",
    lexeme: "barber",
    snippet: '"barber"',
    count: 1,
    why: "The Mode union's own type guard - the definition the two writers above must match.",
  },
  {
    path: "apps/web/src/app/dashboard/assistant/readiness.ts",
    lexeme: "barber",
    snippet: '"barber"',
    count: 4,
    why: 'The readiness WIRE shape: the role union, `scope: "barber"`, and the two scope comparisons. Mirrors ReadinessRole on the API.',
  },

  // ---- Service-name MATCHERS, not copy -------------------------------------
  {
    path: "apps/web/src/app/dashboard/_components/TodayAgenda.tsx",
    lexeme: "lineup",
    snippet: '"lineup"',
    count: 1,
    why: "A keyword the add-on icon matcher looks for in the SHOP'S OWN service names, alongside color/brow/wax for other verticals. Matching more words is inclusive, not barber-only.",
  },

  // ---- Correct barbershop-specific copy: the barber-first homepage --------
  // 🔴 These are a DECISION, not an oversight. The homepage is the beachhead;
  // the /for/<vertical> pages carry the rest. Changing that is a marketing
  // call, not a vocabulary bug.
  {
    path: "apps/web/src/components/marketing/Landing.tsx",
    lexeme: "chair",
    snippet: "chair full.",
    count: 1,
    why: "Hero headline on the barber-first homepage: 'keep your chair full'.",
  },
  {
    path: "apps/web/src/components/marketing/Landing.tsx",
    lexeme: "chair",
    snippet: "them back to your chair.",
    count: 1,
    why: "Win-back section copy on the barber-first homepage.",
  },
  {
    path: "apps/web/src/components/marketing/Landing.tsx",
    lexeme: "barbershops",
    snippet: "texts for barbershops, salons, and studios. No paper cards, no",
    count: 1,
    why: "The homepage subhead, which already names salons and studios alongside barbershops.",
  },
  {
    path: "apps/web/src/components/marketing/Landing.tsx",
    lexeme: "barbershops",
    snippet: '"Is it only for barbershops?"',
    count: 1,
    why: "An FAQ question that exists precisely to answer 'no' - rewording it would delete the answer.",
  },
  {
    path: "apps/web/src/components/marketing/Landing.tsx",
    lexeme: "cut",
    snippet: '"10 cuts for a free cut? 8 for a free beard trim? Your card, your rules, your branding."',
    count: 1,
    why: "Punch-card example on the barber-first homepage.",
  },
  {
    path: "apps/web/src/components/marketing/Landing.tsx",
    lexeme: "cuts",
    snippet: '"10 cuts for a free cut? 8 for a free beard trim? Your card, your rules, your branding."',
    count: 1,
    why: "Same sentence, plural form - counted separately because the lexemes are matched independently.",
  },
  {
    path: "apps/web/src/components/marketing/PunchCardDemo.tsx",
    lexeme: "cut",
    snippet: '"cut"',
    count: 1,
    why: "The animated homepage punch-card demo, showing a barbershop's card.",
  },
  {
    path: "apps/web/src/components/marketing/PunchCardDemo.tsx",
    lexeme: "cuts",
    snippet: '"cuts"',
    count: 1,
    why: "Plural branch of the same demo counter.",
  },
  {
    path: "apps/web/src/components/marketing/PunchCardDemo.tsx",
    lexeme: "cut",
    snippet: "Free Cut",
    count: 1,
    why: "The reward name on the demo card.",
  },
  {
    path: "apps/web/src/components/marketing/DashboardPreview.tsx",
    lexeme: "cut",
    snippet: "due for a cut",
    count: 1,
    why: "The homepage's fake dashboard screenshot, showing a barbershop's data.",
  },
  {
    path: "apps/web/src/components/marketing/Testimonials.tsx",
    lexeme: "chair",
    snippet: '"From the chair"',
    count: 1,
    why: "Testimonial section eyebrow on the barber-first homepage.",
  },

  // ---- Demo fixtures -------------------------------------------------------
  {
    path: "apps/web/src/app/book/manage/[token]/ManageClient.tsx",
    lexeme: "chair",
    snippet: "\"Chair's open early if you can make it — come through!\"",
    count: 1,
    why: "Demo-tour sample nudge text, rendered only inside the guided tour. The demo shop IS a barbershop.",
  },
];

interface Hit {
  path: string;
  lexeme: string;
  snippet: string;
  /** For the failure message only; never part of the exception key. */
  line: number;
}

/**
 * Collapse whitespace and cap length.
 *
 * Keying on this rather than on a line number is what makes an exception
 * survive reindenting and unrelated edits elsewhere in the file, while still
 * breaking when the approved words themselves change.
 */
export function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
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
 * Strip whole comment BLOCKS, tracking state across lines, plus trailing `//`.
 *
 * A line-at-a-time check cannot see the middle of a wrapped comment - a JSX
 * `{/* ... *\/}` continuation line has no leading marker and reads exactly like
 * prose. That produced ~150 false positives on the first run, which is the
 * fastest way to get a guard like this switched off.
 */
function stripComments(src: string): string[] {
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
    const lineComment = text.indexOf("//");
    if (lineComment !== -1 && !/https?:$/.test(text.slice(0, lineComment))) {
      text = text.slice(0, lineComment);
    }
    out.push(text);
  }
  return out;
}

/** Leading `import`/`export ... from "..."` lines are module wiring, not copy. */
function isScannable(line: string): boolean {
  const t = line.trim();
  if (t === "") return false;
  if (t.startsWith("import ") || t.startsWith("export ")) return false;
  if (t.includes('from "')) return false;
  return true;
}

/**
 * The parts of a line a HUMAN reads: string literals and JSX text.
 *
 * This is what makes the scan about copy rather than about a word appearing
 * anywhere. Without it, `data.chair`, `barbers: string;` and
 * `const barber = detail?.staffName` all read as barbershop copy - a property
 * access, a type and a local variable, none of which a customer ever sees.
 */
export function copySegments(line: string): string[] {
  const parts: string[] = [];
  for (const m of line.matchAll(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`/g)) {
    // Drop `${...}` interpolations: CODE inside a string. Without this,
    // `${vocab.stationNoun}` - the FIX - reads as a violation.
    parts.push(m[0].replace(/\$\{[^}]*\}/g, " "));
  }
  for (const m of line.matchAll(/>([^<>{}]+)</g)) parts.push(m[1] ?? "");
  // A JSX text node wrapped across lines has no `>` or `<` of its own, so a
  // line that is PURE PROSE is treated as copy. The operator set is deliberately
  // wide: `base.cuts * priceDelta` and `projCuts: cuts,` are code, and a looser
  // test read them as sentences about haircuts.
  if (parts.length === 0 && !/[<>{}()[\];=+*?:!&|/\\]/.test(line)) parts.push(line);
  return parts;
}

/**
 * Remove the occurrences that are not human-facing words at all.
 *
 * 🔴 NARROW ON PURPOSE. The previous version stripped `\b[a-z-]*fade[a-z-]*\b`,
 * which deleted every word containing "fade" - including a real
 * "the fade is our most-booked service". Only the concrete CSS/motion tokens
 * and the product name are removed, and each is listed so the reach is visible.
 */
export function stripNonCopy(segment: string): string {
  return (
    segment
      // The product name and its domain - inventory only, never renamed.
      .replace(/ChairBack/g, " ")
      .replace(/chairback/gi, " ")
      .replace(/getchairback\.com/g, " ")
      // Tailwind/framer motion tokens. Named individually rather than by a
      // wildcard, so a real word is never swallowed with them.
      .replace(/\banimate-fade-(?:in|out|up|down)\b/g, " ")
      .replace(/\bfade-(?:in|out|up|down)\b/g, " ")
      .replace(/\bfadeUp\b|\bfadeIn\b|\bfadeDown\b|\bfadeOut\b/g, " ")
      // Identifiers that merely CONTAIN a lexeme: barberId, BarberHome,
      // chairScope, useBarber... (camel/Pascal only - a bare word is copy).
      .replace(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:[Bb]arber|[Cc]hair)[A-Za-z0-9_$]*\b/g, " ")
      .replace(/\b(?:barber|chair)[A-Z][A-Za-z0-9_$]*\b/g, " ")
      // The BARBER seat role - authorization wire value, never presentation.
      .replace(/\bBARBER\b/g, " ")
      // URLs. Route paths are NOT stripped wholesale: `/api/barber/...` is
      // approved by an explicit manifest entry instead, so a NEW barber-named
      // route has to be looked at.
      .replace(/https?:\/\/\S+/g, " ")
  );
}

/** Every approved-or-not occurrence in the scanned roots. */
export function collectHits(): Hit[] {
  const hits: Hit[] = [];
  for (const root of ROOTS) {
    for (const file of walk(join(REPO, root))) {
      const rel = relative(REPO, file).split(sep).join("/");
      if (EXCLUDED_PATHS.some((e) => e.match(rel))) continue;
      stripComments(readFileSync(file, "utf8")).forEach((line, i) => {
        if (!isScannable(line)) return;
        for (const raw of copySegments(line)) {
          const segment = stripNonCopy(raw);
          const snippet = normalize(raw);
          for (const m of segment.matchAll(LEXEME_RE)) {
            hits.push({
              path: rel,
              lexeme: m[0].toLowerCase(),
              snippet,
              line: i + 1,
            });
          }
        }
      });
    }
  }
  return hits;
}

export interface Reconciliation {
  /** Occurrences with no remaining allowance. */
  violations: Hit[];
  /** Allowances that were not fully consumed, with how many went unused. */
  stale: { exception: Exception; unused: number }[];
}

/**
 * Match observed occurrences against the manifest as a MULTISET.
 *
 * Each approved occurrence is consumed exactly once. That single rule gives all
 * four contract properties: a duplicate literal exhausts the allowance and
 * fails; a different literal never matches the snippet and fails; a deleted
 * occurrence leaves an allowance unconsumed and fails as stale; and nothing
 * anywhere keys on a line number, so unrelated edits are invisible to it.
 *
 * Pure, and exported, so the properties can be driven with synthetic inputs
 * rather than inferred from the repo's current state.
 */
export function reconcile(hits: Hit[], allowed: Exception[]): Reconciliation {
  const remaining = new Map<string, number>();
  const key = (path: string, lexeme: string, snippet: string) =>
    `${path} ${lexeme} ${snippet}`;

  for (const e of allowed) {
    const k = key(e.path, e.lexeme.toLowerCase(), e.snippet);
    remaining.set(k, (remaining.get(k) ?? 0) + e.count);
  }

  const violations: Hit[] = [];
  for (const h of hits) {
    const k = key(h.path, h.lexeme, h.snippet);
    const left = remaining.get(k) ?? 0;
    if (left > 0) remaining.set(k, left - 1);
    else violations.push(h);
  }

  const stale: { exception: Exception; unused: number }[] = [];
  for (const e of allowed) {
    const k = key(e.path, e.lexeme.toLowerCase(), e.snippet);
    const left = remaining.get(k) ?? 0;
    if (left > 0) {
      stale.push({ exception: e, unused: left });
      remaining.set(k, 0); // report each exception once
    }
  }
  return { violations, stale };
}

/* ------------------------------------------------------------------------ */
/* The matcher's own contract, proven with synthetic inputs.                  */
/* ------------------------------------------------------------------------ */

describe("matcher contract", () => {
  const P = "apps/web/src/app/dashboard/Demo.tsx";
  const SNIP = '"Free Cut unlocked"';
  const approved: Exception[] = [
    { path: P, lexeme: "cut", snippet: SNIP, count: 1, why: "test fixture" },
  ];
  const hit = (over: Partial<Hit> = {}): Hit => ({
    path: P,
    lexeme: "cut",
    snippet: SNIP,
    line: 1,
    ...over,
  });

  it("approves exactly the occurrences it was given", () => {
    const r = reconcile([hit()], approved);
    expect(r.violations).toEqual([]);
    expect(r.stale).toEqual([]);
  });

  it("🔴 a SECOND identical approved literal in the same file fails", () => {
    // The property the old `<path>:<lexeme>` key could not express: one
    // approved "chair" used to bless every later "chair" in that file.
    const r = reconcile([hit({ line: 1 }), hit({ line: 90 })], approved);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.line).toBe(90);
    expect(r.stale).toEqual([]);
  });

  it("🔴 a DIFFERENT literal using the same lexeme in that file fails", () => {
    const r = reconcile([hit(), hit({ snippet: '"Book your next cut"', line: 12 })], approved);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.snippet).toBe('"Book your next cut"');
  });

  it("🔴 removing the approved occurrence makes the exception STALE", () => {
    const r = reconcile([], approved);
    expect(r.violations).toEqual([]);
    expect(r.stale).toHaveLength(1);
    expect(r.stale[0]?.unused).toBe(1);
  });

  it("🔴 moving unrelated lines does NOT break the exception", () => {
    // Same occurrence, different line number: nothing in the key sees it.
    const r = reconcile([hit({ line: 4001 })], approved);
    expect(r.violations).toEqual([]);
    expect(r.stale).toEqual([]);
  });

  it("a count of N approves exactly N and no more", () => {
    const two: Exception[] = [{ ...approved[0]!, count: 2 }];
    expect(reconcile([hit(), hit()], two).violations).toEqual([]);
    expect(reconcile([hit(), hit(), hit()], two).violations).toHaveLength(1);
    expect(reconcile([hit()], two).stale[0]?.unused).toBe(1);
  });

  it("an exception for another file does not cover this one", () => {
    const r = reconcile([hit({ path: "apps/web/src/components/Other.tsx" })], approved);
    expect(r.violations).toHaveLength(1);
    expect(r.stale).toHaveLength(1);
  });
});

describe("scanner contract", () => {
  it("reads copy, not identifiers", () => {
    expect(copySegments('const x = data.chair.name;')).toEqual([]);
    expect(copySegments('<p>Your chair is ready</p>')).toContain("Your chair is ready");
  });

  it("drops ${...} interpolations so the FIX is not a violation", () => {
    const seg = copySegments("`Every ${vocab.stationNoun} is mapped`")[0] ?? "";
    expect(seg).not.toMatch(/stationNoun/);
    expect(stripNonCopy(seg)).not.toMatch(LEXEME_RE);
  });

  it("strips motion tokens WITHOUT swallowing the ordinary word", () => {
    expect(stripNonCopy('"animate-fade-in"')).not.toMatch(/fade/);
    expect(stripNonCopy('"fadeUp"')).not.toMatch(/fade/);
    // 🔴 The regression the old wildcard caused: a real sentence about fades.
    expect(stripNonCopy('"The fade is our most-booked service"')).toMatch(/\bfade\b/);
  });

  it("matches the vertical words the manifest claims to cover", () => {
    for (const w of ["cut", "cuts", "lineup", "line-up", "fades", "haircut", "clippers"]) {
      expect(`a ${w} here`, w).toMatch(LEXEME_RE);
    }
  });

  it("does not match words that merely contain a lexeme", () => {
    for (const w of ["shortcut", "cutoff", "execute", "chairman-ish", "fadeaway"]) {
      expect(`a ${w} here`.match(LEXEME_RE), w).toBeNull();
    }
  });

  it("normalize survives reindenting but not rewording", () => {
    expect(normalize("  Your   chair\n  is ready ")).toBe("Your chair is ready");
    expect(normalize("Your chair is ready")).not.toBe(normalize("Your station is ready"));
  });
});

/* ------------------------------------------------------------------------ */
/* The real repository.                                                       */
/* ------------------------------------------------------------------------ */

describe("no hard-coded barbershop vocabulary in a covered presentation path", () => {
  const hits = collectHits();
  const { violations, stale } = reconcile(hits, ALLOWED);

  it("every occurrence is either vocabulary-driven or an exact approved exception", () => {
    const detail = violations
      .map((h) => `  ${h.path}:${h.line}  [${h.lexeme}]  ${h.snippet}`)
      .join("\n");
    expect(
      violations.length,
      violations.length === 0
        ? ""
        : `Hard-coded vocabulary in ${violations.length} place(s).\n` +
          `Resolve through the shop's vocabulary, or add an exact ALLOWED entry with a reason:\n${detail}`,
    ).toBe(0);
  });

  it("the manifest has no stale entries", () => {
    const detail = stale
      .map((s) => `  ${s.exception.path} [${s.exception.lexeme}] ${s.exception.snippet} (${s.unused} unused)`)
      .join("\n");
    expect(
      stale.length,
      stale.length === 0 ? "" : `Stale ALLOWED entries - delete them:\n${detail}`,
    ).toBe(0);
  });

  it("every exception carries a written reason and a positive count", () => {
    for (const e of ALLOWED) {
      expect(e.why.trim().length, `${e.path} ${e.snippet}`).toBeGreaterThan(20);
      expect(e.count, `${e.path} ${e.snippet}`).toBeGreaterThan(0);
      expect(e.snippet.trim(), e.path).not.toBe("");
      expect(e.path, e.path).toMatch(/^apps\//);
    }
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
   * 🔴 The product boundary, turned into a mechanical check. Business type
   * controls language, recommendations and defaults - never authorization,
   * billing, entitlement or tenancy.
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
        // `initialize.instructions`; excluded by NAME so the exemption is
        // visible rather than pattern-matched.
        if (rel.endsWith("middleware/mcpAuth.ts")) continue;
        const code = stripComments(readFileSync(file, "utf8")).join("\n");
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
     * drags the server API client into the client bundle and fails
     * `next build` with a message about `pages/` that points nowhere near the
     * cause. TYPECHECK DOES NOT CATCH THIS; only the build does.
     */
    const offenders: string[] = [];
    for (const file of walk(join(REPO, "apps", "web", "src"))) {
      const src = readFileSync(file, "utf8");
      if (!/^\s*["']use client["']/m.test(src.split("\n").slice(0, 3).join("\n"))) continue;
      if (/from ["']@\/lib\/vocab["']/.test(src)) {
        offenders.push(relative(REPO, file).split(sep).join("/"));
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
    const policy = readFileSync(join(REPO, "apps", "api", "src", "mcp", "toolPolicy.ts"), "utf8");
    const code = stripComments(policy).join("\n");
    expect(code).not.toMatch(/\b(industry|businessType|vocabulary)\b/);
  });
});
