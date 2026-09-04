import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A test about the TESTS: anything that promises a race has to be shaped like
 * one.
 *
 * 🔴 WHY THIS EXISTS. A mutation audit removed every advisory lock, unique
 * index and compare-and-set this API relies on, and re-ran the suite. Out of
 * 2,904 tests, EIGHT noticed. Sixteen whose names promised "two concurrent X"
 * passed with the guard deleted - including the walk-in capacity lock and all
 * three booking tests literally named "REAL race". They called Promise.all,
 * asserted a count, and proved nothing: the event loop and a fast local
 * database serialise those calls, so the guard is never contended.
 *
 * The rule is mechanical now. If a test's NAME claims concurrency, its body
 * must either use the barrier helper (which forces a real interleaving and
 * fails when the guard is gone) or assert the database constraint directly.
 * If it does neither, it has to say why, in writing, below.
 *
 * This catches the SHAPE, not the substance. `node scripts/falsify-guards.mjs`
 * is what proves a guard is real; this stops the same mistake being written
 * again in between runs.
 */

const API_SRC = join(process.cwd(), "src");

/**
 * Titles that promise concurrency. Deliberately does NOT include bare "exactly
 * one" - that phrase is all over the codebase for SMS segments, default cards
 * and slot lengths, and flagging those would train people to ignore this test.
 */
const RACE_TITLE =
  /\b(concurrent|concurrently|simultaneous|simultaneously|race|races|racing|two workers|both workers|in parallel)\b/i;

/** The shapes that actually prove something, checked against the test's BODY. */
const HONEST_SHAPES = [
  // A real interleaving: hold the guard, let the racers pile up, release.
  "raceBehindBarrier",
  "raceBehindAdvisoryLock",
  "raceBehindRowLock",
  "holdAdvisoryLock",
  "holdRowLock",
  // A whole-table ACCESS EXCLUSIVE lock: the shape that pauses a READER at a
  // chosen point (the slot engine reads "ExternalBlock" last, so a lock on it
  // parks a /day sweep with the old appointments already in hand). Same file,
  // same discipline - it resolves only once the lock is genuinely held, and
  // the test must show the request had NOT settled before release.
  "holdTableLock",
  // Asserting the constraint head-on is the best shape of all: deterministic,
  // instant, and it fails the moment the index or trigger is dropped.
  "rejects.toThrow",
  "skipDuplicates",
];

/**
 * Tests whose title reads like a race but which legitimately need neither
 * shape. Every entry carries its reason, and the second test below deletes
 * stale ones, so this list cannot quietly become a dumping ground.
 */
const EXEMPT: Record<string, string> = {
  "stays SILENT for slot_taken - two customers racing is healthy":
    "asserts a refusal is NOT logged; the race is background colour, not the subject",
  "serves concurrent cold callers one identical body, and recovers after":
    "single-flight CACHE de-duplication in process - no database guard exists to remove",
  "serves concurrent cold callers one identical sweep, and recovers after":
    "single-flight cache de-duplication in process",
  "🔴 a MULTI-SHOP phone gets exactly ONE SMS, naming no shop":
    "message fan-in shaping; 'race' is not in play",
  "concurrent workers lose no increment and cannot exceed MAX_ATTEMPTS":
    "covered by the write-ahead attempt reservation asserted in the same file",
};

/**
 * 🔴 THE FROZEN BACKLOG - the ratchet.
 *
 * These already existed when the audit ran on 2026-08-31. They are listed so
 * the suite stays green while they are reshaped one at a time, and so that
 * ANY NEW race-shaped test has to be written properly from the start. The list
 * may only ever shrink: deleting an entry means the test now uses a barrier or
 * asserts a constraint. Adding one means you are writing new debt, on purpose,
 * in a diff someone will read.
 *
 * "UNPROVEN" means exactly that - nobody has removed its guard and watched it
 * fail. Run `node scripts/falsify-guards.mjs` to find out.
 */
const BACKLOG: Record<string, string> = {
  "concurrent saves of one calendar to two chairs: exactly one wins":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
  "CONCURRENT dispatch of one row creates at most one live block":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
  "cannot be raced past the cap (two concurrent sends, one slot left)":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
  "🔴 two workers racing produce exactly ONE audit event":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
  "🔴 CONCURRENT offer creation: exactly one hold survives":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
  "🔴 claim vs NORMAL BOOKING race: the held slot is the claimant's":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
  "🔴 claim vs expiry RACE: exactly one of them decides":
    "REAL (audited): fails when the offer-expiry CAS predicate is removed",
  "🔴 two CONCURRENT check-ins for one phone leave exactly one entry":
    "REAL (audited): fails when WalkInEntry_one_active_per_phone is dropped",
  "spends exactly once, even under a race":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
  "🔴 two concurrent correct submissions produce exactly one winner":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
  "concurrent provisions (checkout + subscription race) keep ONE number and release the duplicate":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
  "🔴 two CONCURRENT submits create exactly one application":
    "REAL (audited): fails when AffiliateApplication_one_pending_per_shop is dropped",
  "a metadata write racing a webhook cannot walk the status backward":
    "honest already: uses the held-open-transaction barrier from the email work; fold into the shared helper when next touched",
  "forced concurrent 'delivered' and 'bounced' keep the BOUNCE either way":
    "honest already: uses the held-open-transaction barrier from the email work; fold into the shared helper when next touched",
  "forced concurrent 'delivery_delayed' and 'delivered' settle on DELIVERED either way":
    "honest already: uses the held-open-transaction barrier from the email work; fold into the shared helper when next touched",
  "two concurrent FIRST events for an unknown message both record, neither is lost":
    "honest already: uses the held-open-transaction barrier from the email work; fold into the shared helper when next touched",
  "🔴 forced concurrent first events 'sent' and 'delivered' settle on DELIVERED":
    "honest already: uses the held-open-transaction barrier from the email work; fold into the shared helper when next touched",
  "10. concurrent valid redemption still yields exactly one 200":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
  "🔴 two concurrent VALID redemptions yield exactly one token response":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
  "two concurrent submissions produce exactly ONE run":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
  "CONCURRENT double-redeem: the atomic balance check lets exactly one through":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
  "runs the body exactly once under concurrent contention (no double-execute)":
    "REAL (audited): fails when the lease UPDATE loses its free-or-expired condition",
  "concurrent cancels with DIFFERENT clocks still produce one intent and one send":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
  "creates ONE intent when cancellations race":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
  "🔴 the IP ceiling is ATOMIC: a simultaneous burst of distinct phones cannot exceed it":
    "REAL (audited): fails when the rec:<ipHash> advisory lock is removed",
  "🔴 two concurrent correct verifications produce EXACTLY one proof":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
  "🔴 two simultaneous challenge creations leave ONE active row":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
  "🔴 two simultaneous selections produce exactly one credential":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
  "two concurrent requests create exactly ONE run":
    "UNPROVEN: audited 2026-08-31, not yet reshaped",
};

function testFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) testFiles(full, found);
    else if (name.endsWith(".test.ts")) found.push(full);
  }
  return found;
}

/**
 * Each `it(...)` title paired with ITS OWN body, up to the next `it(`.
 *
 * Scoping to the body is load-bearing: a file can hold one honest barrier test
 * and three fake ones, and a whole-file search would bless all four.
 */
function blocksIn(src: string): Array<{ title: string; body: string }> {
  const re = /\bit\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  const found: Array<{ title: string; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    found.push({ title: m[2]!, start: m.index });
  }
  return found.map((f, i) => ({
    title: f.title,
    body: src.slice(f.start, found[i + 1]?.start ?? src.length),
  }));
}

describe("concurrency tests must be shaped like concurrency tests", () => {
  it("🔴 every test whose NAME promises a race uses a barrier, asserts a constraint, or is listed as exempt", () => {
    const offenders: string[] = [];
    for (const file of testFiles(API_SRC)) {
      for (const { title, body } of blocksIn(readFileSync(file, "utf8"))) {
        if (!RACE_TITLE.test(title)) continue;
        if (EXEMPT[title] || BACKLOG[title]) continue;
        if (HONEST_SHAPES.some((shape) => body.includes(shape))) continue;
        offenders.push(`${file.replace(API_SRC, "src")} :: ${title}`);
      }
    }
    expect(
      offenders,
      [
        "These tests promise concurrency but use neither a barrier nor a direct",
        "constraint assertion, so they would pass with the guard deleted:",
        ...offenders.map((o) => `  - ${o}`),
        "",
        "Fix: use apps/api/src/testing/raceBarrier.ts (raceBehindAdvisoryLock /",
        "raceBehindRowLock) and assert settledEarly === 0, or assert the database",
        "constraint directly. If the title is not really about concurrency, add",
        "it to EXEMPT with the reason.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("the exemption list stays honest: no entry for a test that no longer exists", () => {
    const all = new Set<string>();
    for (const file of testFiles(API_SRC)) {
      for (const { title } of blocksIn(readFileSync(file, "utf8"))) all.add(title);
    }
    const stale = [...Object.keys(EXEMPT), ...Object.keys(BACKLOG)].filter(
      (t) => !all.has(t),
    );
    expect(
      stale,
      `EXEMPT names tests that no longer exist:\n${stale.map((s) => `  - ${s}`).join("\n")}`,
    ).toEqual([]);
  });
});
